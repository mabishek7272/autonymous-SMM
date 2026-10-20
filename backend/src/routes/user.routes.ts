import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { UserRole } from '@prisma/client';
import { prisma } from '../utils/database';
import { asyncHandler } from '../utils/async-handler';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { rolesWith } from '../utils/permissions';
import { TeacherRow, importTeachers, validateRows } from '../services/people-import.service';
import { sendAccountCreatedEmail } from '../services/account-email.service';

const router = Router();
router.use(authenticate, authorize(...rolesWith('users:manage')));

const userSelect = { id: true, fullName: true, email: true, role: true, phone: true, initials: true, isActive: true, createdAt: true } as const;

// Staff roles manageable through this generic endpoint. `parent`/`student` portal accounts are
// deliberately excluded: they must only ever be created by the (not-yet-built) auto-provisioning
// flow that sets parentId/studentId, never left dangling and unlinked via this endpoint.
const StaffRole = z.enum(['superadmin', 'admin', 'manager', 'teacher']);

const CreateUserSchema = z.object({
  fullName: z.string().min(2).max(255),
  email: z.string().email(),
  password: z.string().min(8).max(128),
  role: StaffRole,
  phone: z.string().regex(/^\d{10,15}$/, 'digits only, with country code').optional(),
  initials: z.string().trim().min(1).max(10).optional(),
});

const UpdateUserSchema = z.object({
  fullName: z.string().min(2).max(255).optional(),
  role: StaffRole.optional(),
  phone: z.string().regex(/^\d{10,15}$/).nullable().optional(),
  initials: z.string().trim().max(10).nullable().optional(),
  isActive: z.boolean().optional(),
  password: z.string().min(8).max(128).optional(),
});

/** Only a superadmin may create or modify superadmins; admins manage everyone below them. */
function mayGrant(actor: UserRole, target: UserRole): boolean {
  return actor === 'superadmin' || target !== 'superadmin';
}

const ImportBody = z.object({ rows: z.array(z.unknown()).min(1).max(300), dryRun: z.boolean().optional() });

/**
 * POST /api/v1/users/import — create teacher accounts in bulk (superadmin/admin).
 * Passwords are generated and returned ONCE in `credentials` (never stored in plain text) unless a row supplies one.
 * Existing teachers (same email) are not duplicated; their batches can still be assigned.
 */
router.post('/import', asyncHandler(async (req: Request, res: Response) => {
  const body = ImportBody.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: 'Validation failed', details: body.error.flatten() });
  const { items, invalid } = validateRows(TeacherRow, body.data.rows);
  const dryRun = body.data.dryRun === true;
  const result = await importTeachers(items, { dryRun, actorId: req.user!.userId });
  res.status(dryRun ? 200 : 201).json({ ...result, invalid: [...invalid, ...result.invalid].sort((a, b) => a.row - b.row) });
}));

/**
 * GET /api/v1/users — staff accounts only (superadmin/admin/manager/teacher).
 * `parent`/`student` portal accounts are a different kind of account — auto-provisioned,
 * self-scoped, never managed through this staff UI — so they're excluded here, not just
 * hidden client-side, keeping the API response itself scoped to staff.
 */
router.get('/', asyncHandler(async (_req: Request, res: Response) => {
  const users = await prisma.user.findMany({
    where: { role: { in: StaffRole.options } },
    select: userSelect,
    orderBy: { createdAt: 'asc' },
  });
  res.json({ data: users });
}));

/** POST /api/v1/users */
router.post('/', asyncHandler(async (req: Request, res: Response) => {
  const parsed = CreateUserSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
  const { password, ...data } = parsed.data;
  if (!mayGrant(req.user!.role, data.role)) return void res.status(403).json({ error: 'Only a superadmin can create superadmins' });
  if (await prisma.user.findUnique({ where: { email: data.email } })) {
    return void res.status(409).json({ error: 'User with this email already exists' });
  }
  const user = await prisma.user.create({ data: { ...data, passwordHash: await bcrypt.hash(password, 12) }, select: userSelect });
  // Welcome email without the password: the administrator who typed it shares it directly
  const emailed = await sendAccountCreatedEmail(user, { role: user.role });
  res.status(201).json({ ...user, emailed });
}));

/** PATCH /api/v1/users/:id */
router.patch('/:id', asyncHandler(async (req: Request, res: Response) => {
  const parsed = UpdateUserSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
  const target = await prisma.user.findUnique({ where: { id: String(req.params.id) } });
  if (!target) return void res.status(404).json({ error: 'User not found' });
  const actor = req.user!;
  if (!mayGrant(actor.role, target.role) || (parsed.data.role && !mayGrant(actor.role, parsed.data.role))) {
    return void res.status(403).json({ error: 'Only a superadmin can modify superadmins' });
  }
  if (target.id === actor.userId && (parsed.data.isActive === false || (parsed.data.role && parsed.data.role !== target.role))) {
    return void res.status(400).json({ error: 'You cannot deactivate or change the role of your own account' });
  }
  const { password, ...rest } = parsed.data;
  const user = await prisma.user.update({
    where: { id: target.id },
    data: { ...rest, ...(password ? { passwordHash: await bcrypt.hash(password, 12) } : {}) },
    select: userSelect,
  });
  res.json(user);
}));

export default router;
