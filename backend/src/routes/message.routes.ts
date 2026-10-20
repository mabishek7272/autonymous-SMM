import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { prisma } from '../utils/database';
import { asyncHandler } from '../utils/async-handler';
import { rolesWith } from '../utils/permissions';
import { messagingAdapter } from '../services/messaging.adapter';
import { fromAddress, isEmailEnabled } from '../services/email.service';
import { notifyParent } from '../services/notify.service';
import { enqueueWhatsApp } from '../utils/queues';

const router = Router();
router.use(authenticate);

const canManageLeads = authorize(...rolesWith('leads:manage'));
const canViewDashboard = authorize(...rolesWith('dashboard:view'));

const ListQuerySchema = z.object({
  leadId: z.string().uuid().optional(),
  parentId: z.string().uuid().optional(),
  studentId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
}).refine((v) => v.leadId || v.parentId || v.studentId, {
  message: 'One of leadId, parentId or studentId is required',
});

const SendSchema = z.object({
  text: z.string().trim().min(1).max(4000),
});

// GET /api/v1/messages/status — is the WhatsApp gateway linked and online?
router.get('/status', canViewDashboard, asyncHandler(async (_req: Request, res: Response) => {
  const whatsapp = await messagingAdapter.getConnectionStatus();
  res.json({
    ...whatsapp,
    email: {
      enabled: isEmailEnabled(),
      domain: process.env.EMAIL_DOMAIN || 'e-kalavya.com',
      senders: (['general', 'security', 'reports', 'system'] as const).map((k) => fromAddress(k)),
    },
  });
}));

// GET /api/v1/messages?leadId=|parentId=|studentId= — conversation history, oldest first within the page
router.get('/', canManageLeads, asyncHandler(async (req: Request, res: Response) => {
  const parsed = ListQuerySchema.safeParse(req.query);
  if (!parsed.success) return void res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
  const { leadId, parentId, studentId, page, pageSize } = parsed.data;

  const where = {
    ...(leadId ? { leadId } : {}),
    ...(parentId ? { parentId } : {}),
    ...(studentId ? { studentId } : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.message.count({ where }),
    prisma.message.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);
  res.json({ data: rows.reverse(), page, pageSize, total, totalPages: Math.ceil(total / pageSize) });
}));

// POST /api/v1/messages/lead/:leadId — staff sends a manual WhatsApp message to the lead's parent
router.post('/lead/:leadId', canManageLeads, asyncHandler(async (req: Request, res: Response) => {
  const leadId = z.string().uuid().safeParse(req.params.leadId);
  if (!leadId.success) return void res.status(400).json({ error: 'Invalid lead id' });
  const body = SendSchema.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: 'Validation failed', details: body.error.flatten() });

  const lead = await prisma.lead.findUnique({ where: { id: leadId.data }, include: { parent: true } });
  if (!lead) return void res.status(404).json({ error: 'Lead not found' });
  if (lead.parent.optedOut) {
    return void res.status(409).json({ error: 'Parent has opted out of WhatsApp messages', optedOutAt: lead.parent.optedOutAt });
  }

  // Delivery (and the Message row, agentId null) happens in the queue worker, which audit-logs the staff member.
  await enqueueWhatsApp({
    to: lead.parent.whatsappNumber,
    text: body.data.text,
    agentId: `staff:${req.user!.userId}`,
    targetId: lead.id,
    parentId: lead.parentId,
    leadId: lead.id,
    messageKind: 'manual',
  });
  // Same message by email when the parent has an address (WhatsApp above keeps its own pipeline)
  const email = await notifyParent({
    parent: lead.parent,
    leadId: lead.id,
    agentId: `staff:${req.user!.userId}`,
    targetId: lead.id,
    email: {
      kind: 'general',
      subject: 'A message from E-Kalavya',
      title: 'A message from E-Kalavya',
      paragraphs: body.data.text.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean),
      footnote: 'Reply to this email or on WhatsApp to continue the conversation.',
    },
  });
  res.status(202).json({ status: 'queued', leadId: lead.id, channels: { whatsapp: 'queued', email: email.email } });
}));

export default router;
