import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { prisma } from '../utils/database';
import { asyncHandler } from '../utils/async-handler';
import { rolesWith, isBatchScoped, canAccessBatch, canAccessStudent } from '../utils/permissions';
import {
  ServiceError,
  approveReports,
  currentWeekStart,
  generateForStudents,
  sendApprovedReports,
  sendReport,
} from '../services/weekly-report.service';
import { dateOnly, withRedisLock } from '../services/scheduler.service';

const router = Router();
router.use(authenticate);

const canReview = authorize(...rolesWith('reports:review'));

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const IdSchema = z.string().uuid();

const GenerateSchema = z.object({
  weekStart: dateStr.optional(),
  batchId: z.string().uuid().optional(),
  force: z.boolean().optional(),
});
const ListSchema = z.object({
  status: z.enum(['draft', 'approved', 'sent', 'failed']).optional(),
  weekStart: dateStr.optional(),
  batchId: z.string().uuid().optional(),
});
const PatchSchema = z.object({ summary: z.string().trim().min(1).max(4000) });
const BulkSchema = z.object({ ids: z.array(z.string().uuid()).min(1).max(500) });

/** Prisma filter limiting reports to students the caller may see. */
function scopeWhere(user: NonNullable<Request['user']>): Prisma.WeeklyReportWhereInput {
  return isBatchScoped(user.role) ? { student: { enrollments: { some: { batch: { teacherId: user.userId } } } } } : {};
}

function badRequest(res: Response, error: z.ZodError) {
  return void res.status(400).json({ error: 'Validation failed', details: error.flatten() });
}

/** Loads a report the caller may access; sends the error response and returns null otherwise. */
async function loadScoped(req: Request, res: Response) {
  const id = IdSchema.safeParse(req.params.id);
  if (!id.success) { res.status(400).json({ error: 'Invalid report id' }); return null; }
  const report = await prisma.weeklyReport.findUnique({ where: { id: id.data }, include: { student: { select: { id: true, fullName: true } } } });
  if (!report) { res.status(404).json({ error: 'Report not found' }); return null; }
  if (!(await canAccessStudent(req.user!, report.studentId))) { res.status(403).json({ error: 'Not your student' }); return null; }
  return report;
}

/** Ids from the list the caller is allowed to act on. */
async function scopedIds(user: NonNullable<Request['user']>, ids: string[]): Promise<string[]> {
  const rows = await prisma.weeklyReport.findMany({ where: { id: { in: ids }, ...scopeWhere(user) }, select: { id: true } });
  return rows.map((r) => r.id);
}

function handleServiceError(res: Response, err: unknown) {
  if (err instanceof ServiceError) return void res.status(err.status).json({ error: err.message });
  throw err;
}

// POST /api/v1/reports/generate — draft reports for a batch, or every active student
router.post('/generate', canReview, asyncHandler(async (req: Request, res: Response) => {
  const parsed = GenerateSchema.safeParse(req.body ?? {});
  if (!parsed.success) return badRequest(res, parsed.error);
  const user = req.user!;
  const { batchId, force } = parsed.data;
  const weekStart = parsed.data.weekStart ?? currentWeekStart();

  let studentIds: string[] | undefined;
  if (batchId) {
    if (!(await canAccessBatch(user, batchId))) return void res.status(403).json({ error: 'Not your batch' });
    const batch = await prisma.batch.findUnique({ where: { id: batchId }, select: { id: true } });
    if (!batch) return void res.status(404).json({ error: 'Batch not found' });
    studentIds = (await prisma.enrollment.findMany({ where: { batchId }, select: { studentId: true } })).map((e) => e.studentId);
  } else if (isBatchScoped(user.role)) {
    studentIds = (await prisma.enrollment.findMany({ where: { batch: { teacherId: user.userId } }, select: { studentId: true } })).map((e) => e.studentId);
  }

  try {
    const result = await generateForStudents(weekStart, { studentIds, force });
    res.status(201).json(result);
  } catch (err) {
    handleServiceError(res, err);
  }
}));

// GET /api/v1/reports?status=&weekStart=&batchId=
router.get('/', canReview, asyncHandler(async (req: Request, res: Response) => {
  const parsed = ListSchema.safeParse(req.query);
  if (!parsed.success) return badRequest(res, parsed.error);
  const user = req.user!;
  const { status, weekStart, batchId } = parsed.data;
  if (batchId && !(await canAccessBatch(user, batchId))) return void res.status(403).json({ error: 'Not your batch' });

  const reports = await prisma.weeklyReport.findMany({
    where: {
      AND: [
        scopeWhere(user),
        status ? { status } : {},
        weekStart ? { weekStart: dateOnly(weekStart) } : {},
        batchId ? { student: { enrollments: { some: { batchId } } } } : {},
      ],
    },
    include: { student: { select: { id: true, fullName: true, parent: { select: { id: true, fullName: true, optedOut: true } } } } },
    orderBy: [{ weekStart: 'desc' }, { createdAt: 'desc' }],
    take: 500,
  });
  res.json(reports);
}));

// POST /api/v1/reports/bulk-approve — registered before /:id routes
router.post('/bulk-approve', canReview, asyncHandler(async (req: Request, res: Response) => {
  const parsed = BulkSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error);
  const allowed = await scopedIds(req.user!, parsed.data.ids);
  const approved = await approveReports(allowed, req.user!.userId);
  const approvedSet = new Set(approved);
  res.json({
    approved,
    skipped: parsed.data.ids
      .filter((id) => !approvedSet.has(id))
      .map((id) => ({ id, reason: allowed.includes(id) ? 'Not a draft' : 'Not found or not accessible' })),
  });
}));

// POST /api/v1/reports/send-approved — sends every approved report
router.post('/send-approved', canReview, asyncHandler(async (req: Request, res: Response) => {
  const user = req.user!;
  const ids = isBatchScoped(user.role)
    ? (await prisma.weeklyReport.findMany({ where: { status: 'approved', ...scopeWhere(user) }, select: { id: true } })).map((r) => r.id)
    : undefined;
  const locked = await withRedisLock('weekly-report:send', 1800, () => sendApprovedReports(ids));
  if (!locked.acquired) return void res.status(409).json({ error: 'A send run is already in progress' });
  res.json(locked.result);
}));

// GET /api/v1/reports/:id
router.get('/:id', canReview, asyncHandler(async (req: Request, res: Response) => {
  const report = await loadScoped(req, res);
  if (report) res.json(report);
}));

// PATCH /api/v1/reports/:id — edit the summary while still a draft
router.patch('/:id', canReview, asyncHandler(async (req: Request, res: Response) => {
  const parsed = PatchSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error);
  const report = await loadScoped(req, res);
  if (!report) return;
  // Conditional update so a concurrent approve cannot be edited after the fact
  const { count } = await prisma.weeklyReport.updateMany({ where: { id: report.id, status: 'draft' }, data: { summary: parsed.data.summary } });
  if (count === 0) return void res.status(409).json({ error: 'Only draft reports can be edited' });
  res.json(await prisma.weeklyReport.findUnique({ where: { id: report.id } }));
}));

// POST /api/v1/reports/:id/approve
router.post('/:id/approve', canReview, asyncHandler(async (req: Request, res: Response) => {
  const report = await loadScoped(req, res);
  if (!report) return;
  const approved = await approveReports([report.id], req.user!.userId);
  if (approved.length === 0) return void res.status(409).json({ error: `Report is ${report.status}, only drafts can be approved` });
  res.json(await prisma.weeklyReport.findUnique({ where: { id: report.id } }));
}));

// POST /api/v1/reports/:id/send — approved (or previously failed) reports only
router.post('/:id/send', canReview, asyncHandler(async (req: Request, res: Response) => {
  const report = await loadScoped(req, res);
  if (!report) return;
  try {
    const outcome = await sendReport(report.id);
    if (outcome.outcome === 'failed') return void res.status(502).json({ error: `Sending failed: ${outcome.reason}`, outcome });
    if (outcome.outcome === 'skipped') return void res.status(422).json({ error: outcome.reason, outcome });
    res.json({ outcome, report: await prisma.weeklyReport.findUnique({ where: { id: report.id } }) });
  } catch (err) {
    handleServiceError(res, err);
  }
}));

export default router;
