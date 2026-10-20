import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { prisma } from '../utils/database';
import { asyncHandler } from '../utils/async-handler';
import {
  rolesWith,
  isBatchScoped,
  canAccessBatch,
  canAccessStudent,
} from '../utils/permissions';

const router = Router();
router.use(authenticate);

const canRead = authorize(...rolesWith('students:read'));
const canManageAcademics = authorize(...rolesWith('academics:manage'));
const canManageStudents = authorize(...rolesWith('students:manage'));

const CreateRecordSchema = z.object({
  studentId: z.string().uuid(),
  subject: z.string().min(1).max(100),
  markObtained: z.number().nonnegative(),
  totalMarks: z.number().positive(),
  attendancePercentage: z.number().min(0).max(100).optional(),
  testDate: z.string().optional(),
  teacherComments: z.string().max(2000).optional(),
}).refine((v) => v.markObtained <= v.totalMarks, { message: 'markObtained cannot exceed totalMarks', path: ['markObtained'] });

const CourseSchema = z.object({
  courseName: z.string().min(2).max(255),
  description: z.string().max(2000).optional(),
});

const BatchSchema = z.object({
  courseId: z.string().uuid(),
  batchName: z.string().min(1).max(100),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  teacherId: z.string().uuid().optional(),
});

const EnrollSchema = z.object({ studentId: z.string().uuid() });

// GET /api/v1/academic/students/:studentId/records
router.get('/students/:studentId/records', canRead, asyncHandler(async (req: Request, res: Response) => {
  const studentId = String(req.params.studentId);
  if (!(await canAccessStudent(req.user!, studentId))) return void res.status(403).json({ error: 'Not your student' });
  const records = await prisma.academicRecord.findMany({
    where: { studentId },
    orderBy: { testDate: 'desc' },
  });
  res.json(records);
}));

// POST /api/v1/academic/records — marks entry (teachers only for students in their own batches)
router.post('/records', canManageAcademics, asyncHandler(async (req: Request, res: Response) => {
  const parsed = CreateRecordSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
  if (!(await canAccessStudent(req.user!, parsed.data.studentId))) return void res.status(403).json({ error: 'Not your student' });

  const { testDate, ...rest } = parsed.data;
  const record = await prisma.academicRecord.create({
    data: { ...rest, testDate: testDate ? new Date(testDate) : new Date() },
  });
  res.status(201).json(record);
}));

// GET /api/v1/academic/students/:studentId/summary — Academic Monitoring AI tool
router.get('/students/:studentId/summary', canRead, asyncHandler(async (req: Request, res: Response) => {
  const studentId = String(req.params.studentId);
  if (!(await canAccessStudent(req.user!, studentId))) return void res.status(403).json({ error: 'Not your student' });

  const records = await prisma.academicRecord.findMany({ where: { studentId } });
  if (records.length === 0) return void res.json({ studentId, summary: null, message: 'No records found' });

  const bySubject: Record<string, { total: number; obtained: number; count: number }> = {};
  for (const r of records) {
    if (!r.subject) continue;
    bySubject[r.subject] ??= { total: 0, obtained: 0, count: 0 };
    bySubject[r.subject].total += Number(r.totalMarks ?? 0);
    bySubject[r.subject].obtained += Number(r.markObtained ?? 0);
    bySubject[r.subject].count++;
  }

  const subjectSummary = Object.entries(bySubject).map(([subject, data]) => ({
    subject,
    averagePercentage: data.total > 0 ? Math.round((data.obtained / data.total) * 100) : 0,
    assessments: data.count,
    flag: data.total > 0 && data.obtained / data.total < 0.5 ? 'WEAK' : 'OK',
  }));
  res.json({ studentId, subjectSummary });
}));

// ── Courses ───────────────────────────────────────────────────

router.get('/courses', canRead, asyncHandler(async (_req: Request, res: Response) => {
  res.json(await prisma.course.findMany({ include: { batches: true } }));
}));

router.post('/courses', canManageStudents, asyncHandler(async (req: Request, res: Response) => {
  const parsed = CourseSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
  res.status(201).json(await prisma.course.create({ data: parsed.data }));
}));

// ── Batches ───────────────────────────────────────────────────

// GET /api/v1/academic/batches — teachers see only their own batches
router.get('/batches', canRead, asyncHandler(async (req: Request, res: Response) => {
  const user = req.user!;
  const batches = await prisma.batch.findMany({
    where: isBatchScoped(user.role) ? { teacherId: user.userId } : undefined,
    include: {
      course: true,
      teacher: { select: { id: true, fullName: true, email: true } },
      classLink: { select: { id: true, name: true, meetingUrl: true, isActive: true } },
      schedules: { orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }] },
      enrollments: { include: { student: { select: { id: true, fullName: true, status: true } } } },
    },
    orderBy: { startDate: 'desc' },
  });
  res.json(batches);
}));

router.post('/batches', canManageStudents, asyncHandler(async (req: Request, res: Response) => {
  const parsed = BatchSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
  const { startDate, endDate, ...rest } = parsed.data;
  if (rest.teacherId) {
    const teacher = await prisma.user.findFirst({ where: { id: rest.teacherId, role: 'teacher', isActive: true } });
    if (!teacher) return void res.status(400).json({ error: 'teacherId must be an active teacher' });
  }
  const batch = await prisma.batch.create({
    data: {
      ...rest,
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
    },
    include: { course: true, teacher: { select: { id: true, fullName: true } } },
  });
  res.status(201).json(batch);
}));

const UpdateBatchSchema = z.object({
  batchName: z.string().min(1).max(100).optional(),
  teacherId: z.string().uuid().nullable().optional(),
  classLinkId: z.string().uuid().nullable().optional(),
  startDate: z.string().nullable().optional(),
  endDate: z.string().nullable().optional(),
}).refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const ScheduleSchema = z.object({
  slots: z.array(z.object({
    dayOfWeek: z.number().int().min(0).max(6),
    startTime: z.string().regex(HHMM, 'HH:mm, 24-hour, IST'),
    durationMinutes: z.number().int().min(5).max(480).default(60),
    /** Overrides the batch's standing link for this slot; null/omitted = use the batch link */
    classLinkId: z.string().uuid().nullable().optional(),
  })).max(42),
});

// PATCH /api/v1/academic/batches/:batchId — rename, reassign teacher, attach the standing class link
router.patch('/batches/:batchId', canManageStudents, asyncHandler(async (req: Request, res: Response) => {
  const parsed = UpdateBatchSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
  const batchId = String(req.params.batchId);
  const { startDate, endDate, ...rest } = parsed.data;
  if (rest.teacherId) {
    const teacher = await prisma.user.findFirst({ where: { id: rest.teacherId, role: 'teacher', isActive: true } });
    if (!teacher) return void res.status(400).json({ error: 'teacherId must be an active teacher' });
  }
  if (rest.classLinkId) {
    const link = await prisma.classLink.findFirst({ where: { id: rest.classLinkId, isActive: true } });
    if (!link) return void res.status(400).json({ error: 'classLinkId must be an active class link' });
  }
  if (!(await prisma.batch.findUnique({ where: { id: batchId }, select: { id: true } }))) {
    return void res.status(404).json({ error: 'Batch not found' });
  }
  const batch = await prisma.batch.update({
    where: { id: batchId },
    data: {
      ...rest,
      ...(startDate !== undefined ? { startDate: startDate ? new Date(startDate) : null } : {}),
      ...(endDate !== undefined ? { endDate: endDate ? new Date(endDate) : null } : {}),
    },
    include: {
      course: true,
      teacher: { select: { id: true, fullName: true } },
      classLink: { select: { id: true, name: true, meetingUrl: true, isActive: true } },
      schedules: { orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }] },
    },
  });
  res.json(batch);
}));

// PUT /api/v1/academic/batches/:batchId/schedule — replace the weekly class slots (IST)
router.put('/batches/:batchId/schedule', canManageStudents, asyncHandler(async (req: Request, res: Response) => {
  const parsed = ScheduleSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
  const batchId = String(req.params.batchId);
  if (!(await prisma.batch.findUnique({ where: { id: batchId }, select: { id: true } }))) {
    return void res.status(404).json({ error: 'Batch not found' });
  }
  const seen = new Set<string>();
  for (const slot of parsed.data.slots) {
    const key = `${slot.dayOfWeek}@${slot.startTime}`;
    if (seen.has(key)) return void res.status(400).json({ error: `Duplicate slot ${key}` });
    seen.add(key);
  }
  const linkIds = [...new Set(parsed.data.slots.map((s) => s.classLinkId).filter((x): x is string => !!x))];
  if (linkIds.length) {
    const found = await prisma.classLink.count({ where: { id: { in: linkIds }, isActive: true } });
    if (found !== linkIds.length) return void res.status(400).json({ error: 'Every slot link must be an active class link' });
  }
  const schedules = await prisma.$transaction(async (tx) => {
    await tx.batchSchedule.deleteMany({ where: { batchId } });
    if (parsed.data.slots.length) {
      await tx.batchSchedule.createMany({ data: parsed.data.slots.map((s) => ({ ...s, classLinkId: s.classLinkId ?? null, batchId })) });
    }
    return tx.batchSchedule.findMany({ where: { batchId }, orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }] });
  });
  res.json(schedules);
}));

// GET /api/v1/academic/batches/:batchId/students — roster for attendance / marks entry
router.get('/batches/:batchId/students', canRead, asyncHandler(async (req: Request, res: Response) => {
  const batchId = String(req.params.batchId);
  if (!(await canAccessBatch(req.user!, batchId))) return void res.status(403).json({ error: 'Not your batch' });
  const enrollments = await prisma.enrollment.findMany({
    where: { batchId },
    include: {
      student: {
        include: {
          parent: { select: { id: true, fullName: true } },
          academicRecords: { orderBy: { testDate: 'desc' }, take: 5 },
        },
      },
    },
  });
  res.json(enrollments.map((e) => e.student));
}));

// POST /api/v1/academic/batches/:batchId/enroll
router.post('/batches/:batchId/enroll', canManageStudents, asyncHandler(async (req: Request, res: Response) => {
  const parsed = EnrollSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
  const batchId = String(req.params.batchId);
  const existing = await prisma.enrollment.findUnique({
    where: { studentId_batchId: { studentId: parsed.data.studentId, batchId } },
  });
  if (existing) return void res.status(409).json({ error: 'Student is already enrolled in this batch' });
  const enrollment = await prisma.enrollment.create({
    data: { batchId, studentId: parsed.data.studentId },
    include: { student: true, batch: true },
  });
  res.status(201).json(enrollment);
}));

export default router;
