import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { prisma } from '../utils/database';
import { asyncHandler } from '../utils/async-handler';
import { rolesWith } from '../utils/permissions';
import { runRuleNow, unknownPlaceholders, TEMPLATE_PLACEHOLDERS } from '../services/reminder-rule.service';
import { withRedisLock } from '../services/scheduler.service';

const router = Router();
router.use(authenticate);

const canManage = authorize(...rolesWith('reminders:manage'));

const templateField = z.string().trim().min(1).max(2000).superRefine((t, ctx) => {
  const bad = unknownPlaceholders(t);
  if (bad.length) {
    ctx.addIssue({ code: 'custom', message: `Unknown placeholder(s): ${bad.map((b) => `{{${b}}}`).join(', ')}. Allowed: ${TEMPLATE_PLACEHOLDERS.map((p) => `{{${p}}}`).join(', ')}` });
  }
});

const RuleSchema = z.object({
  name: z.string().trim().min(1).max(120),
  audience: z.enum(['teacher', 'parent']),
  dayOfWeek: z.number().int().min(0).max(6),
  timeOfDay: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'timeOfDay must be HH:mm (24h, IST)'),
  template: templateField,
  enabled: z.boolean().default(true),
});
const UpdateSchema = RuleSchema.partial().refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });
const IdSchema = z.string().uuid();

function parseId(req: Request, res: Response): string | null {
  const id = IdSchema.safeParse(req.params.id);
  if (!id.success) { res.status(400).json({ error: 'Invalid rule id' }); return null; }
  return id.data;
}

// GET /api/v1/reminders
router.get('/', canManage, asyncHandler(async (_req: Request, res: Response) => {
  res.json(await prisma.reminderRule.findMany({ orderBy: { createdAt: 'asc' } }));
}));

// POST /api/v1/reminders
router.post('/', canManage, asyncHandler(async (req: Request, res: Response) => {
  const parsed = RuleSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
  res.status(201).json(await prisma.reminderRule.create({ data: { ...parsed.data, createdById: req.user!.userId } }));
}));

// GET /api/v1/reminders/:id
router.get('/:id', canManage, asyncHandler(async (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (!id) return;
  const rule = await prisma.reminderRule.findUnique({ where: { id } });
  if (!rule) return void res.status(404).json({ error: 'Reminder rule not found' });
  res.json(rule);
}));

// PATCH /api/v1/reminders/:id
router.patch('/:id', canManage, asyncHandler(async (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (!id) return;
  const parsed = UpdateSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
  if (!(await prisma.reminderRule.findUnique({ where: { id }, select: { id: true } }))) {
    return void res.status(404).json({ error: 'Reminder rule not found' });
  }
  res.json(await prisma.reminderRule.update({ where: { id }, data: parsed.data }));
}));

// DELETE /api/v1/reminders/:id
router.delete('/:id', canManage, asyncHandler(async (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (!id) return;
  const { count } = await prisma.reminderRule.deleteMany({ where: { id } });
  if (count === 0) return void res.status(404).json({ error: 'Reminder rule not found' });
  res.status(204).end();
}));

// POST /api/v1/reminders/:id/run-now — send immediately, ignoring the schedule
router.post('/:id/run-now', canManage, asyncHandler(async (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (!id) return;
  const locked = await withRedisLock(`reminder-rule:run:${id}`, 120, () => runRuleNow(id));
  if (!locked.acquired) return void res.status(409).json({ error: 'This rule is already running' });
  if (!locked.result) return void res.status(404).json({ error: 'Reminder rule not found' });
  res.json(locked.result);
}));

export default router;
