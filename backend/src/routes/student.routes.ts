import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { prisma } from '../utils/database';
import { z } from 'zod';
import { asyncHandler } from '../utils/async-handler';
import { rolesWith, isBatchScoped, canAccessStudent } from '../utils/permissions';
import { StudentRow, importStudents, validateRows } from '../services/people-import.service';
import { notifyParent, delivered } from '../services/notify.service';
import { Prisma, LeadStatus } from '@prisma/client';
import { logger } from '../utils/logger';

const router = Router();
router.use(authenticate);

const CreateStudentSchema = z.object({
  parentId: z.string().uuid(),
  fullName: z.string().min(2).max(255),
  dateOfBirth: z.string().optional(),
  admissionDate: z.string().optional(),
});

// GET /api/v1/students
router.get('/', authorize(...rolesWith('students:read')), asyncHandler(async (req: Request, res: Response) => {
  const user = req.user!;
  const students = await prisma.student.findMany({
    where: isBatchScoped(user.role) ? { enrollments: { some: { batch: { teacherId: user.userId } } } } : undefined,
    include: { parent: true, enrollments: { include: { batch: { include: { course: true } } } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json(students);
}));

// GET /api/v1/students/:id
router.get('/:id', authorize(...rolesWith('students:read')), asyncHandler(async (req: Request, res: Response) => {
  const id = String(req.params.id);
  if (!(await canAccessStudent(req.user!, id))) return void res.status(403).json({ error: 'Not your student' });
  const student = await prisma.student.findUnique({
    where: { id },
    include: {
      parent: true,
      enrollments: { include: { batch: { include: { course: true } } } },
      academicRecords: { orderBy: { testDate: 'desc' } },
    },
  });
  if (!student) { res.status(404).json({ error: 'Student not found' }); return; }
  res.json(student);
}));

// POST /api/v1/students — admission (students:manage)
router.post('/', authorize(...rolesWith('students:manage')), asyncHandler(async (req: Request, res: Response) => {
  const parsed = CreateStudentSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() }); return; }

  const { dateOfBirth, admissionDate, ...rest } = parsed.data;
  const student = await prisma.student.create({
    data: {
      ...rest,
      dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : undefined,
      admissionDate: admissionDate ? new Date(admissionDate) : new Date(),
    },
  });
  res.status(201).json(student);
}));

const ImportBody = z.object({ rows: z.array(z.unknown()).min(1).max(500), dryRun: z.boolean().optional() });

/**
 * POST /api/v1/students/import — register students in bulk with their parent and the batches (class + subject)
 * they study. Parents are matched by WhatsApp number; an existing student only gains the missing batches.
 */
router.post('/import', authorize(...rolesWith('students:manage')), asyncHandler(async (req: Request, res: Response) => {
  const body = ImportBody.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: 'Validation failed', details: body.error.flatten() });
  const { items, invalid } = validateRows(StudentRow, body.data.rows);
  const dryRun = body.data.dryRun === true;
  const result = await importStudents(items, { dryRun, actorId: req.user!.userId });
  res.status(dryRun ? 200 : 201).json({ ...result, invalid: [...invalid, ...result.invalid].sort((a, b) => a.row - b.row) });
}));

/** POST /api/v1/students/register — add one student with the parent's details (same rules as the import). */
router.post('/register', authorize(...rolesWith('students:manage')), asyncHandler(async (req: Request, res: Response) => {
  const { items, invalid } = validateRows(StudentRow, [req.body]);
  if (invalid.length) return void res.status(400).json({ error: invalid[0].message, details: invalid });
  const result = await importStudents(items, { dryRun: false, actorId: req.user!.userId });
  if (result.invalid.length) return void res.status(400).json({ error: result.invalid[0].message, details: result.invalid });
  const student = await prisma.student.findUniqueOrThrow({
    where: { id: result.studentIds[0] },
    include: { parent: true, enrollments: { include: { batch: true } } },
  });
  res.status(result.created ? 201 : 200).json({ student, created: result.created === 1, enrollmentsAdded: result.enrollmentsAdded });
}));

const OnboardLeadSchema = z.object({
  leadId: z.string().uuid(),
  studentName: z.string().trim().min(2).max(255),
  batchId: z.string().uuid().optional(),
  dateOfBirth: z.string().optional(),
  paymentReference: z.string().trim().min(3).max(128),
  amountPaid: z.number().positive().max(10_000_000),
  paymentMode: z.string().trim().min(1).max(40).default('UPI'),
});

/** Lead stages from which an admission is allowed (never enquiry/contacted/lost). */
const ADMISSIBLE_LEAD_STATUSES: LeadStatus[] = ['qualified', 'demo_scheduled', 'follow_up', 'converted'];

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/**
 * POST /api/v1/students/onboard-lead
 * Converts a qualified/demo lead into an admitted student upon verified payment.
 * Payment, student, enrollment, lead status and audit row commit atomically;
 * the welcome WhatsApp is queued only after the commit.
 * Per Dev_Plan.md Phase 3 & Security_Plan.md HITL requirements.
 */
router.post('/onboard-lead', authorize(...rolesWith('students:manage')), asyncHandler(async (req: Request, res: Response) => {
  const parsed = OnboardLeadSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }

  const { leadId, studentName, batchId, dateOfBirth, paymentReference, amountPaid, paymentMode } = parsed.data;
  const dob = dateOfBirth ? new Date(dateOfBirth) : undefined;
  if (dob && Number.isNaN(dob.getTime())) {
    res.status(400).json({ error: 'Validation failed', details: { fieldErrors: { dateOfBirth: ['Invalid date'] } } });
    return;
  }
  const recordedById = req.user!.userId;

  let outcome;
  try {
    outcome = await prisma.$transaction(async (tx) => {
      const lead = await tx.lead.findUnique({ where: { id: leadId }, include: { parent: true } });
      if (!lead) throw new HttpError(404, 'Lead not found');
      if (!ADMISSIBLE_LEAD_STATUSES.includes(lead.status)) {
        throw new HttpError(409, `Lead is '${lead.status}'; admission requires one of: ${ADMISSIBLE_LEAD_STATUSES.join(', ')}`);
      }

      if (batchId) {
        const batch = await tx.batch.findUnique({ where: { id: batchId }, select: { id: true } });
        if (!batch) throw new HttpError(404, 'Batch not found');
      }

      const duplicate = await tx.payment.findUnique({ where: { reference: paymentReference }, select: { id: true } });
      if (duplicate) throw new HttpError(409, 'paymentReference has already been recorded');

      // 1. Student
      const student = await tx.student.create({
        data: { parentId: lead.parentId, fullName: studentName, dateOfBirth: dob, admissionDate: new Date(), status: 'active' },
        include: { parent: true },
      });

      // 1b. Auto-create a parent-role portal account if the parent has an email and doesn't have one yet.
      // Login for parent/student roles is OTP-only (see auth.controller.login); passwordHash is a
      // required column but must never hold anything usable, so it's a random value hashed and
      // immediately discarded — nobody, including this code, ever knows it, and bcrypt.compare
      // against it can never succeed.
      let portalAccountCreated = false;
      if (lead.parent.email) {
        const existing = await tx.user.findUnique({ where: { email: lead.parent.email } });
        if (!existing) {
          await tx.user.create({
            data: {
              fullName: lead.parent.fullName,
              email: lead.parent.email,
              passwordHash: await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12),
              role: 'parent',
              parentId: lead.parentId,
            },
          });
          portalAccountCreated = true;
        }
      }

      // 2. Payment
      const payment = await tx.payment.create({
        data: { reference: paymentReference, amount: amountPaid, method: paymentMode, leadId, studentId: student.id, recordedById },
      });

      // 3. Enrollment if batch selected
      const enrollment = batchId
        ? await tx.enrollment.create({
            data: { studentId: student.id, batchId, enrollmentDate: new Date() },
            include: { batch: { include: { course: true } } },
          })
        : null;

      // 4. Lead -> converted
      await tx.lead.update({ where: { id: leadId }, data: { status: 'converted' } });

      // 5. Audit entry (same transaction so it can never disagree with the data)
      await tx.aiActivityLog.create({
        data: {
          agentId: `user:${recordedById}`,
          targetId: student.id,
          actionType: 'lead_onboarded_to_student',
          payload: { leadId, studentId: student.id, paymentId: payment.id, paymentReference, amountPaid, paymentMode, batchId: batchId ?? null },
          status: 'success',
        },
      });

      return { student, enrollment, payment, parent: lead.parent, portalAccountCreated };
    });
  } catch (err) {
    if (err instanceof HttpError) { res.status(err.status).json({ error: err.message }); return; }
    // Lost the race on a unique constraint — could be Payment.reference or (since the portal
    // account is created in this same transaction) User.email. Prisma's P2002 meta carries
    // modelName/target naming the conflicting constraint, so use that to report the real cause
    // instead of always assuming it was the payment reference.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const meta = err.meta as { modelName?: string; target?: string[] } | undefined;
      const target = Array.isArray(meta?.target) ? meta.target.join(',') : '';
      if (meta?.modelName === 'User' || target.includes('email')) {
        res.status(409).json({ error: 'A user account with this email already exists' });
      } else {
        res.status(409).json({ error: 'paymentReference has already been recorded' });
      }
      return;
    }
    throw err;
  }

  // 6. Welcome message on both channels — outside the transaction; a queue failure must not undo a committed admission.
  const { parent, portalAccountCreated, ...result } = outcome;
  let welcomeMessage: 'queued' | 'skipped_no_number' | 'skipped_opted_out' | 'failed' = 'queued';
  if (parent?.optedOut) welcomeMessage = 'skipped_opted_out';
  else if (!parent) welcomeMessage = 'skipped_no_number';
  else {
    try {
      let welcomeText = `🎉 Welcome to E-Kalavya, ${parent.fullName}!\n\nAdmission for ${studentName} is confirmed (Payment Ref: ${paymentReference}). Your academic batch schedule and teacher intro will arrive shortly.\n\nWe are thrilled to partner in your child's success! 🚀`;
      if (portalAccountCreated && process.env.PORTAL_URL) {
        welcomeText += `\n\nYou can also track attendance, reports and class links online — log in at ${process.env.PORTAL_URL} with your email (${parent.email}); we'll send you a one-time code, no password needed.`;
      }
      const sent = await notifyParent({
        parent,
        studentId: result.student.id,
        agentId: 'ParentEngagementAI',
        targetId: result.student.id,
        whatsapp: parent.whatsappNumber ? welcomeText : null,
        email: {
          kind: 'general',
          subject: `Welcome to E-Kalavya: ${studentName}'s admission is confirmed`,
          title: `Welcome to E-Kalavya, ${parent.fullName}!`,
          paragraphs: [
            `Admission for ${studentName} is confirmed. Your academic batch schedule and teacher introduction will arrive shortly.`,
            "We are thrilled to partner in your child's success.",
          ],
          details: [['Student', studentName], ['Payment reference', paymentReference]],
        },
        idempotencyKey: `welcome-${result.student.id}`,
      });
      if (!delivered(sent)) welcomeMessage = sent.whatsapp === 'failed' || sent.email === 'failed' ? 'failed' : 'skipped_no_number';
    } catch (err) {
      welcomeMessage = 'failed';
      logger.error('Failed to send admission welcome message', {
        studentId: result.student.id, message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  res.status(201).json({ ...result, welcomeMessage });
}));

export default router;
