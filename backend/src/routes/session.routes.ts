import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { prisma } from '../utils/database';
import { asyncHandler } from '../utils/async-handler';
import { rolesWith, isBatchScoped, canAccessBatch } from '../utils/permissions';
import { istDateString, istDayRange, parseYmd } from '../services/attendance.service';
import { announceSession } from '../services/class-link.service';

const router = Router();
router.use(authenticate);

const canManage = authorize(...rolesWith('sessions:manage'));

const httpsUrl = z.string().url().max(2000).refine((u) => {
  try { return new URL(u).protocol === 'https:'; } catch { return false; }
}, { message: 'meetingUrl must be an https URL' });

const CreateSchema = z.object({
  batchId: z.string().uuid(),
  topic: z.string().max(255).optional(),
  startsAt: z.string().datetime({ offset: true }),
  durationMinutes: z.number().int().min(5).max(480).optional(),
  // Optional: defaults to the batch's standing class link
  meetingUrl: httpsUrl.optional(),
  notes: z.string().max(2000).optional(),
});

const UpdateSchema = z.object({
  topic: z.string().max(255).nullable().optional(),
  startsAt: z.string().datetime({ offset: true }).optional(),
  durationMinutes: z.number().int().min(5).max(480).optional(),
  meetingUrl: httpsUrl.optional(),
  notes: z.string().max(2000).nullable().optional(),
}).refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });

const ListQuery = z.object({
  batchId: z.string().uuid().optional(),
  date: z.string().refine((s) => parseYmd(s) !== null, { message: 'Expected YYYY-MM-DD' }).optional(),
});

const include = { batch: { select: { id: true, batchName: true } } } as const;

/** Owner or admin-level roles may modify; teachers must also own the batch. */
async function canModify(req: Request, session: { batchId: string; createdById: string | null }): Promise<boolean> {
  const user = req.user!;
  if (!isBatchScoped(user.role)) return true;
  return session.createdById === user.userId && (await canAccessBatch(user, session.batchId));
}

// POST /api/v1/sessions
router.post('/', canManage, asyncHandler(async (req: Request, res: Response) => {
  const parsed = CreateSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
  const { startsAt, meetingUrl, ...rest } = parsed.data;
  const batch = await prisma.batch.findUnique({
    where: { id: rest.batchId },
    select: { id: true, classLink: { select: { meetingUrl: true, isActive: true } } },
  });
  if (!batch) return void res.status(404).json({ error: 'Batch not found' });
  if (!(await canAccessBatch(req.user!, rest.batchId))) return void res.status(403).json({ error: 'Not your batch' });

  const url = meetingUrl ?? (batch.classLink?.isActive ? batch.classLink.meetingUrl : undefined);
  if (!url) {
    return void res.status(400).json({ error: 'This batch has no class link assigned. Enter a meeting link or ask a manager to assign one.' });
  }

  const session = await prisma.classSession.create({
    data: { ...rest, meetingUrl: url, startsAt: new Date(startsAt), createdById: req.user!.userId },
    include,
  });
  res.status(201).json(session);
}));

// GET /api/v1/sessions/today — today's sessions (IST), scoped
router.get('/today', canManage, asyncHandler(async (req: Request, res: Response) => {
  const { start, end } = istDayRange(istDateString());
  const sessions = await prisma.classSession.findMany({
    where: {
      startsAt: { gte: start, lt: end },
      ...(isBatchScoped(req.user!.role) ? { batch: { teacherId: req.user!.userId } } : {}),
    },
    include,
    orderBy: { startsAt: 'asc' },
  });
  res.json(sessions);
}));

// GET /api/v1/sessions?batchId=&date=
router.get('/', canManage, asyncHandler(async (req: Request, res: Response) => {
  const parsed = ListQuery.safeParse(req.query);
  if (!parsed.success) return void res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
  const { batchId, date } = parsed.data;
  if (batchId && !(await canAccessBatch(req.user!, batchId))) return void res.status(403).json({ error: 'Not your batch' });

  const range = date ? istDayRange(date) : null;
  const sessions = await prisma.classSession.findMany({
    where: {
      ...(batchId ? { batchId } : {}),
      ...(range ? { startsAt: { gte: range.start, lt: range.end } } : {}),
      ...(isBatchScoped(req.user!.role) ? { batch: { teacherId: req.user!.userId } } : {}),
    },
    include,
    orderBy: { startsAt: 'asc' },
    take: 500,
  });
  res.json(sessions);
}));

// PATCH /api/v1/sessions/:id
router.patch('/:id', canManage, asyncHandler(async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const parsed = UpdateSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
  const existing = await prisma.classSession.findUnique({ where: { id } });
  if (!existing) return void res.status(404).json({ error: 'Session not found' });
  if (!(await canModify(req, existing))) return void res.status(403).json({ error: 'Only the creator or an admin/manager can modify this session' });

  const { startsAt, ...rest } = parsed.data;
  const updated = await prisma.classSession.update({
    where: { id },
    data: { ...rest, ...(startsAt ? { startsAt: new Date(startsAt) } : {}) },
    include,
  });
  res.json(updated);
}));

// DELETE /api/v1/sessions/:id
router.delete('/:id', canManage, asyncHandler(async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const existing = await prisma.classSession.findUnique({ where: { id } });
  if (!existing) return void res.status(404).json({ error: 'Session not found' });
  if (!(await canModify(req, existing))) return void res.status(403).json({ error: 'Only the creator or an admin/manager can delete this session' });
  await prisma.classSession.delete({ where: { id } });
  res.status(204).end();
}));

// POST /api/v1/sessions/:id/announce — send now
router.post('/:id/announce', canManage, asyncHandler(async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const existing = await prisma.classSession.findUnique({ where: { id } });
  if (!existing) return void res.status(404).json({ error: 'Session not found' });
  if (!(await canAccessBatch(req.user!, existing.batchId))) return void res.status(403).json({ error: 'Not your batch' });
  const result = await announceSession(id);
  if (!result) return void res.status(409).json({ error: 'Session has already been announced', announcedAt: existing.announcedAt });
  res.json(result);
}));

export default router;
