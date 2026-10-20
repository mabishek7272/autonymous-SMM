import { Router, Request, Response } from 'express';
import { prisma } from '../utils/database';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { ownStudentIds, rolesWith } from '../utils/permissions';
import { asyncHandler } from '../utils/async-handler';

const router = Router();

// Customer-only route group: parent/student accounts never reach any other /api/v1/* route,
// and staff accounts never reach this one. portal:view is the only permission either role holds.
router.use(authenticate, authorize(...rolesWith('portal:view')));

// Trust boundary: parentId/studentId below come ONLY from req.user, populated server-side by
// authenticate() from the verified JWT — never from req.params/req.query/req.body.
async function scopeOrEmpty(req: Request): Promise<string[]> {
  return ownStudentIds({ role: req.user!.role, parentId: req.user!.parentId, studentId: req.user!.studentId });
}

/** GET /api/v1/portal/overview — which batches each of the caller's own children is enrolled in. */
router.get('/overview', asyncHandler(async (req: Request, res: Response) => {
  const studentIds = await scopeOrEmpty(req);
  const students = await prisma.student.findMany({
    where: { id: { in: studentIds } },
    include: { enrollments: { include: { batch: { include: { course: true } } } } },
  });
  res.json({
    students: students.map((s) => ({
      id: s.id,
      fullName: s.fullName,
      grade: s.grade,
      board: s.board,
      status: s.status,
      batches: s.enrollments.map((e) => ({ batchId: e.batchId, batchName: e.batch.batchName, course: e.batch.course.courseName })),
    })),
  });
}));

/** GET /api/v1/portal/attendance — attendance history for the caller's own children only. */
router.get('/attendance', asyncHandler(async (req: Request, res: Response) => {
  const studentIds = await scopeOrEmpty(req);
  const rows = await prisma.attendance.findMany({
    where: { studentId: { in: studentIds } },
    orderBy: { date: 'desc' },
    take: 90,
    select: { studentId: true, batchId: true, date: true, status: true, note: true },
  });
  res.json({ attendance: rows });
}));

/** GET /api/v1/portal/reports — weekly reports already sent/approved for the caller's own children. */
router.get('/reports', asyncHandler(async (req: Request, res: Response) => {
  const studentIds = await scopeOrEmpty(req);
  const rows = await prisma.weeklyReport.findMany({
    where: { studentId: { in: studentIds }, status: { in: ['approved', 'sent'] } },
    orderBy: { weekStart: 'desc' },
    take: 26,
    select: { studentId: true, weekStart: true, summary: true, metrics: true, sentAt: true },
  });
  res.json({ reports: rows });
}));

/** GET /api/v1/portal/class-today — today's class link(s) for the caller's own children's batches. */
router.get('/class-today', asyncHandler(async (req: Request, res: Response) => {
  const studentIds = await scopeOrEmpty(req);
  const enrollments = await prisma.enrollment.findMany({ where: { studentId: { in: studentIds } }, select: { batchId: true, studentId: true } });
  const batchIds = [...new Set(enrollments.map((e) => e.batchId))];
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(end.getDate() + 1);
  const sessions = await prisma.classSession.findMany({
    where: { batchId: { in: batchIds }, startsAt: { gte: start, lt: end } },
    orderBy: { startsAt: 'asc' },
    select: { batchId: true, topic: true, startsAt: true, durationMinutes: true, meetingUrl: true },
  });
  res.json({ sessions });
}));

/** GET /api/v1/portal/payments — read-only payment history staff have recorded for the caller's own children. */
router.get('/payments', asyncHandler(async (req: Request, res: Response) => {
  const studentIds = await scopeOrEmpty(req);
  const payments = await prisma.payment.findMany({
    where: { studentId: { in: studentIds } },
    orderBy: { paidAt: 'desc' },
    select: { reference: true, amount: true, currency: true, method: true, paidAt: true, studentId: true },
  });
  res.json({ payments });
}));

export default router;
