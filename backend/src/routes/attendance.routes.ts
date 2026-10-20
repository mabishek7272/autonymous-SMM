import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { prisma } from '../utils/database';
import { asyncHandler } from '../utils/async-handler';
import { rolesWith, canAccessBatch, canAccessStudent } from '../utils/permissions';
import { notifyParent, delivered } from '../services/notify.service';
import { aiActivityLogService } from '../services/ai-activity-log.service';
import {
  computeAttendancePercentage,
  istDateString,
  parseYmd,
} from '../services/attendance.service';

const router = Router();
router.use(authenticate);

const canMark = authorize(...rolesWith('attendance:mark'));

const YmdSchema = z.string().refine((s) => parseYmd(s) !== null, { message: 'Expected a valid date in YYYY-MM-DD format' });

const MarkSchema = z.object({
  date: YmdSchema,
  entries: z.array(z.object({
    studentId: z.string().uuid(),
    status: z.enum(['present', 'absent', 'late', 'excused']),
    note: z.string().max(500).optional(),
  })).min(1).max(500),
});

const DateQuery = z.object({ date: YmdSchema });
const RangeQuery = z.object({ from: YmdSchema, to: YmdSchema })
  .refine((v) => v.from <= v.to, { message: 'from must not be after to', path: ['from'] });

async function batchExists(batchId: string): Promise<boolean> {
  return !!(await prisma.batch.findUnique({ where: { id: batchId }, select: { id: true } }));
}

// POST /api/v1/attendance/batches/:batchId — bulk mark (upsert) for one date
router.post('/batches/:batchId', canMark, asyncHandler(async (req: Request, res: Response) => {
  const batchId = String(req.params.batchId);
  const parsed = MarkSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
  const { date, entries } = parsed.data;

  if (!(await batchExists(batchId))) return void res.status(404).json({ error: 'Batch not found' });
  if (!(await canAccessBatch(req.user!, batchId))) return void res.status(403).json({ error: 'Not your batch' });
  if (date > istDateString()) return void res.status(400).json({ error: 'Cannot mark attendance for a future date' });

  const ids = entries.map((e) => e.studentId);
  if (new Set(ids).size !== ids.length) return void res.status(400).json({ error: 'Duplicate studentId in entries' });

  const enrolled = await prisma.enrollment.findMany({ where: { batchId, studentId: { in: ids } }, select: { studentId: true } });
  const enrolledSet = new Set(enrolled.map((e) => e.studentId));
  const notEnrolled = ids.filter((id) => !enrolledSet.has(id));
  if (notEnrolled.length) {
    return void res.status(400).json({ error: 'Some students are not enrolled in this batch', studentIds: notEnrolled });
  }

  const day = parseYmd(date)!;
  const markedById = req.user!.userId;
  const saved = await prisma.$transaction(
    entries.map((e) => prisma.attendance.upsert({
      where: { studentId_batchId_date: { studentId: e.studentId, batchId, date: day } },
      create: { studentId: e.studentId, batchId, date: day, status: e.status, note: e.note ?? null, markedById },
      update: { status: e.status, note: e.note ?? null, markedById },
    }))
  );
  res.status(200).json({ batchId, date, saved: saved.length });
}));

// POST /api/v1/attendance/batches/:batchId/notify-absent — tell parents (WhatsApp + email) their child was absent on a date.
// Explicit, not automatic, so a teacher can correct a mistake first. Each student is notified once per date.
router.post('/batches/:batchId/notify-absent', canMark, asyncHandler(async (req: Request, res: Response) => {
  const batchId = String(req.params.batchId);
  const parsed = DateQuery.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
  const date = parsed.data.date;
  if (date > istDateString()) return void res.status(400).json({ error: 'Cannot notify about a future date' });
  if (!(await batchExists(batchId))) return void res.status(404).json({ error: 'Batch not found' });
  if (!(await canAccessBatch(req.user!, batchId))) return void res.status(403).json({ error: 'Not your batch' });

  const batch = await prisma.batch.findUniqueOrThrow({ where: { id: batchId }, select: { batchName: true } });
  const absent = await prisma.attendance.findMany({
    where: { batchId, date: parseYmd(date)!, status: 'absent', student: { status: 'active' } },
    include: { student: { include: { parent: true } } },
  });

  const out = { absent: absent.length, notified: 0, alreadyNotified: 0, skippedOptedOut: 0, noContact: 0, failed: 0 };
  const label = new Date(`${date}T12:00:00Z`).toLocaleDateString('en-IN', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });
  for (const a of absent) {
    const { student } = a;
    const already = await prisma.aiActivityLog.findFirst({
      where: { actionType: 'absence_notified', targetId: `${student.id}:${date}`, status: 'success', payload: { path: ['batchId'], equals: batchId } },
      select: { id: true },
    });
    if (already) { out.alreadyNotified++; continue; }
    if (student.parent.optedOut) { out.skippedOptedOut++; continue; }

    const r = await notifyParent({
      parent: student.parent,
      studentId: student.id,
      agentId: 'attendance-notifier',
      targetId: student.id,
      whatsapp: `Hello ${student.parent.fullName}, ${student.fullName} was marked absent for ${batch.batchName ?? 'class'} on ${label}. If this is a mistake or you would like to share a reason, please reply to this message.`,
      email: {
        kind: 'reports',
        subject: `${student.fullName} was absent on ${label}`,
        title: `${student.fullName} was absent`,
        paragraphs: [`${student.fullName} was marked absent for ${batch.batchName ?? 'class'} on ${label}.`, 'If this is a mistake, or you would like to share a reason, please reply to this email or WhatsApp us.'],
        details: [['Student', student.fullName], ['Class', batch.batchName ?? ''], ['Date', label]],
      },
      idempotencyKey: `absent-${student.id}-${date}-${batchId}`,
    });
    if (delivered(r)) {
      out.notified++;
      await aiActivityLogService.log({
        agentId: 'attendance-notifier',
        targetId: `${student.id}:${date}`, // ai_activity_log.target_id is VarChar(64); the batch is in the payload
        actionType: 'absence_notified',
        payload: { studentId: student.id, batchId, date, by: req.user!.userId, whatsapp: r.whatsapp, email: r.email },
        status: 'success',
      });
    } else if (r.whatsapp === 'failed' || r.email === 'failed') out.failed++;
    else out.noContact++;
  }
  res.json(out);
}));

// GET /api/v1/attendance/batches/:batchId?date= — roster with that day's status (null = unmarked)
router.get('/batches/:batchId', canMark, asyncHandler(async (req: Request, res: Response) => {
  const batchId = String(req.params.batchId);
  const parsed = DateQuery.safeParse(req.query);
  if (!parsed.success) return void res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
  if (!(await batchExists(batchId))) return void res.status(404).json({ error: 'Batch not found' });
  if (!(await canAccessBatch(req.user!, batchId))) return void res.status(403).json({ error: 'Not your batch' });

  const { date } = parsed.data;
  const [enrollments, marks] = await Promise.all([
    prisma.enrollment.findMany({
      where: { batchId },
      include: { student: { select: { id: true, fullName: true, status: true } } },
      orderBy: { student: { fullName: 'asc' } },
    }),
    prisma.attendance.findMany({ where: { batchId, date: parseYmd(date)! } }),
  ]);
  const byStudent = new Map(marks.map((m) => [m.studentId, m]));
  res.json({
    batchId,
    date,
    roster: enrollments.map((e) => {
      const m = byStudent.get(e.studentId);
      return {
        studentId: e.studentId,
        fullName: e.student.fullName,
        studentStatus: e.student.status,
        status: m?.status ?? null,
        note: m?.note ?? null,
      };
    }),
  });
}));

// GET /api/v1/attendance/batches/:batchId/summary?from=&to=
router.get('/batches/:batchId/summary', canMark, asyncHandler(async (req: Request, res: Response) => {
  const batchId = String(req.params.batchId);
  const parsed = RangeQuery.safeParse(req.query);
  if (!parsed.success) return void res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
  if (!(await batchExists(batchId))) return void res.status(404).json({ error: 'Batch not found' });
  if (!(await canAccessBatch(req.user!, batchId))) return void res.status(403).json({ error: 'Not your batch' });

  const from = parseYmd(parsed.data.from)!;
  const to = parseYmd(parsed.data.to)!;
  if ((to.getTime() - from.getTime()) / 86_400_000 + 1 > 366) return void res.status(400).json({ error: 'Date range cannot exceed 366 days' });

  const [enrollments, marks] = await Promise.all([
    prisma.enrollment.findMany({ where: { batchId }, include: { student: { select: { id: true, fullName: true } } } }),
    prisma.attendance.findMany({ where: { batchId, date: { gte: from, lte: to } } }),
  ]);
  const byStudent = new Map<string, typeof marks>();
  for (const m of marks) byStudent.set(m.studentId, [...(byStudent.get(m.studentId) ?? []), m]);

  // A class day = a date on which anyone in this batch was marked; others are unmarked for the student
  const classDays = [...new Set(marks.map((m) => m.date.toISOString().slice(0, 10)))].sort();
  const students = enrollments.map((e) => {
    const mine = byStudent.get(e.studentId) ?? [];
    const markedSet = new Set(mine.map((m) => m.date.toISOString().slice(0, 10)));
    const presentDays = mine.filter((m) => m.status === 'present' || m.status === 'late').length;
    return {
      studentId: e.studentId,
      fullName: e.student.fullName,
      daysMarked: mine.length,
      presentDays,
      percentage: mine.length > 0 ? Math.round((presentDays / mine.length) * 1000) / 10 : null,
      unmarkedDays: classDays.filter((d) => !markedSet.has(d)),
    };
  });
  res.json({ batchId, from: parsed.data.from, to: parsed.data.to, classDays, students });
}));

// GET /api/v1/attendance/students/:studentId?from=&to= — history + percentage
router.get('/students/:studentId', canMark, asyncHandler(async (req: Request, res: Response) => {
  const studentId = String(req.params.studentId);
  const parsed = RangeQuery.safeParse(req.query);
  if (!parsed.success) return void res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
  const student = await prisma.student.findUnique({ where: { id: studentId }, select: { id: true, fullName: true } });
  if (!student) return void res.status(404).json({ error: 'Student not found' });
  if (!(await canAccessStudent(req.user!, studentId))) return void res.status(403).json({ error: 'Not your student' });

  const from = parseYmd(parsed.data.from)!;
  const to = parseYmd(parsed.data.to)!;
  const [history, stats] = await Promise.all([
    prisma.attendance.findMany({
      where: {
        studentId,
        date: { gte: from, lte: to },
        // Teachers see only attendance from their own batches
        ...(req.user!.role === 'teacher' ? { batch: { teacherId: req.user!.userId } } : {}),
      },
      include: { batch: { select: { id: true, batchName: true } } },
      orderBy: { date: 'desc' },
    }),
    computeAttendancePercentage(studentId, from, to),
  ]);
  // Teachers' percentage must match what they can see
  const visible = req.user!.role === 'teacher'
    ? (() => {
        const presentDays = history.filter((h) => h.status === 'present' || h.status === 'late').length;
        return {
          markedDays: history.length,
          presentDays,
          percentage: history.length ? Math.round((presentDays / history.length) * 1000) / 10 : null,
        };
      })()
    : stats;
  res.json({ studentId, fullName: student.fullName, from: parsed.data.from, to: parsed.data.to, ...visible, history });
}));

export default router;
