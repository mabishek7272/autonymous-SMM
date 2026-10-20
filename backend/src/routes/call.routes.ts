import { Router } from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { rolesWith } from '../utils/permissions';
import { prisma } from '../utils/database';
import { asyncHandler } from '../utils/async-handler';

/** Staff view of voice call logs written by the call agent (POST /agent-api/call-log). */
const router = Router();
router.use(authenticate, authorize(...rolesWith('leads:manage')));

const ListQuery = z.object({
  leadId: z.string().uuid().optional(),
  parentId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

// GET /api/v1/calls?leadId=&parentId=&page=&limit= — newest first
router.get('/', asyncHandler(async (req, res) => {
  const parsed = ListQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid query', details: parsed.error.flatten().fieldErrors });
    return;
  }
  const { leadId, parentId, page, limit } = parsed.data;
  const where = { ...(leadId ? { leadId } : {}), ...(parentId ? { parentId } : {}) };
  const [rows, total] = await Promise.all([
    prisma.callLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
    prisma.callLog.count({ where }),
  ]);
  res.json({ data: rows, page, limit, total, totalPages: Math.ceil(total / limit) });
}));

// GET /api/v1/calls/:id
router.get('/:id', asyncHandler(async (req, res) => {
  if (!z.string().uuid().safeParse(req.params.id).success) {
    res.status(400).json({ error: 'Invalid call id' });
    return;
  }
  const call = await prisma.callLog.findUnique({ where: { id: req.params.id } });
  if (!call) {
    res.status(404).json({ error: 'Call not found' });
    return;
  }
  res.json(call);
}));

export default router;
