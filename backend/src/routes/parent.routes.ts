import { Router } from 'express';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { rolesWith } from '../utils/permissions';
import { prisma } from '../utils/database';
import { z } from 'zod';
import { Request, Response } from 'express';
import { asyncHandler } from '../utils/async-handler';
import { Prisma } from '@prisma/client';

const router = Router();
router.use(authenticate, authorize(...rolesWith('leads:manage')));

/**
 * Canonical WhatsApp number: digits only with country code (matches the webhook
 * format, e.g. 919876543210). A bare 10-digit Indian mobile gets the 91 prefix.
 */
export function normaliseWhatsappNumber(raw: string): string {
  let digits = raw.replace(/[\s\-().]/g, '').replace(/^\+/, '').replace(/^00/, '');
  if (/^0\d{10}$/.test(digits)) digits = digits.slice(1);
  if (/^[6-9]\d{9}$/.test(digits)) digits = `91${digits}`;
  return digits;
}

const CreateParentSchema = z.object({
  fullName: z.string().trim().min(2).max(255),
  whatsappNumber: z.string().trim().max(24).transform(normaliseWhatsappNumber)
    .refine((n) => /^\d{10,15}$/.test(n), 'whatsappNumber must be a valid phone number with 10-15 digits'),
  email: z.string().trim().toLowerCase().email().max(255).optional(),
  address: z.string().trim().max(1000).optional(),
});

const IdParam = z.string().uuid();

router.get('/', asyncHandler(async (_req: Request, res: Response) => {
  const parents = await prisma.parent.findMany({
    include: { leads: true, students: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json(parents);
}));

router.get('/:id', asyncHandler(async (req: Request, res: Response) => {
  const id = IdParam.safeParse(req.params.id);
  if (!id.success) { res.status(400).json({ error: 'Invalid parent id' }); return; }
  const parent = await prisma.parent.findUnique({
    where: { id: id.data },
    include: { leads: true, students: { include: { academicRecords: true } } },
  });
  if (!parent) { res.status(404).json({ error: 'Parent not found' }); return; }
  res.json(parent);
}));

router.post('/', asyncHandler(async (req: Request, res: Response) => {
  const parsed = CreateParentSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() }); return; }
  try {
    const parent = await prisma.parent.create({ data: parsed.data });
    res.status(201).json(parent);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      res.status(409).json({ error: 'A parent with this WhatsApp number already exists' });
      return;
    }
    throw err;
  }
}));

export default router;
