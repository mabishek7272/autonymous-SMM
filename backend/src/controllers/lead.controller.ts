import { Request, Response } from 'express';
import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { aiActivityLogService } from '../services/ai-activity-log.service';
import { z } from 'zod';
import { LeadStatus, LeadSource, Prisma } from '@prisma/client';
import { approvalService } from '../services/approval.service';
import { normalizePhone } from '../utils/phone';

const CreateLeadSchema = z.object({
  parentId: z.string().uuid().optional(),
  // If parentId not provided, parent details can be included for auto-creation
  parentName: z.string().min(2).max(255).optional(),
  whatsappNumber: z.string().max(20).optional(),
  source: z.nativeEnum(LeadSource).optional(),
  gradeInterested: z.string().max(50).optional(),
  boardInterested: z.string().max(50).optional(),
  subjectsInterested: z.array(z.string()).optional(),
  requirements: z.string().optional(),
  notes: z.string().max(5000).optional(),
});

const UpdateStatusSchema = z.object({
  status: z.nativeEnum(LeadStatus),
  // Set when an AI agent is the caller; agents never apply guarded transitions directly.
  agentId: z.string().max(100).optional(),
  reason: z.string().max(1000).optional(),
});

const ListLeadsQuery = z.object({
  status: z.nativeEnum(LeadStatus).optional(),
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const QualifyLeadSchema = z.object({
  gradeInterested: z.string().max(50),
  boardInterested: z.string().max(50),
  subjectsInterested: z.array(z.string()),
  requirements: z.string().optional(),
  notes: z.string().max(5000).optional(),
  aiScore: z.number().int().min(0).max(100).optional(),
  agentId: z.string().default('AdmissionsAI'),
});

/** Prisma "record not found" on update/delete. */
function isNotFound(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025';
}

/**
 * Marking a lead lost is a guarded action: only superadmin/admin apply it directly.
 * An AI agent or any other role files a 'lead.mark_lost' approval instead.
 */
async function markLost(req: Request, res: Response, agentId?: string, reason?: string): Promise<void> {
  const lead = await prisma.lead.findUnique({ where: { id: req.params.id }, include: { parent: true } });
  if (!lead) {
    res.status(404).json({ error: 'Lead not found' });
    return;
  }
  const role = req.user?.role;
  if (!agentId && (role === 'superadmin' || role === 'admin')) {
    const updated = await prisma.lead.update({ where: { id: lead.id }, data: { status: 'lost' } });
    await aiActivityLogService.log({
      agentId: 'human',
      targetId: lead.id,
      actionType: 'lead_marked_lost',
      payload: { by: req.user?.userId, role },
      status: 'success',
    });
    res.json(updated);
    return;
  }

  const approval =
    (await approvalService.findPending('lead.mark_lost', lead.id)) ??
    (await approvalService.requestApproval({
      agentId: agentId ?? `user:${req.user?.userId ?? 'unknown'}`,
      actionType: 'lead.mark_lost',
      title: `Mark lead ${lead.parent.fullName} as lost`,
      reason: reason ?? (agentId ? `Requested by ${agentId}` : `Requested by ${role} user`),
      payload: { leadId: lead.id, previousStatus: lead.status },
      targetId: lead.id,
      risk: 'medium',
    }));
  res.status(202).json({
    pendingApproval: true,
    approvalId: approval.id,
    message: 'Marking a lead as lost needs admin approval. The lead status has not changed.',
  });
}

export async function getLeads(req: Request, res: Response): Promise<void> {
  const parsed = ListLeadsQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }
  const { status, q, page, limit } = parsed.data;

  try {
    const where: Prisma.LeadWhereInput = {};
    if (status) where.status = status;
    if (q) {
      where.parent = {
        OR: [
          { fullName: { contains: q, mode: 'insensitive' } },
          { whatsappNumber: { contains: q.replace(/[\s+\-()]/g, '') || q } },
        ],
      };
    }

    const [leads, total] = await Promise.all([
      prisma.lead.findMany({
        where,
        include: { parent: true, appointments: { orderBy: { scheduledAt: 'desc' }, take: 1 } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.lead.count({ where }),
    ]);

    res.json({
      data: leads,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    logger.error('getLeads error', { error });
    res.status(500).json({ error: 'Failed to fetch leads' });
  }
}

export async function getLeadById(req: Request, res: Response): Promise<void> {
  try {
    const lead = await prisma.lead.findUnique({
      where: { id: req.params.id },
      include: { parent: true, appointments: true },
    });
    if (!lead) {
      res.status(404).json({ error: 'Lead not found' });
      return;
    }
    res.json(lead);
  } catch (error) {
    logger.error('getLeadById error', { error });
    res.status(500).json({ error: 'Failed to fetch lead' });
  }
}

export async function createLead(req: Request, res: Response): Promise<void> {
  const parsed = CreateLeadSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }

  const { parentId, parentName, whatsappNumber, ...leadData } = parsed.data;

  try {
    // Auto-create parent if not provided
    let resolvedParentId = parentId;
    if (!resolvedParentId) {
      if (!parentName || !whatsappNumber) {
        res.status(400).json({ error: 'Either parentId or parentName+whatsappNumber is required' });
        return;
      }
      const phone = normalizePhone(whatsappNumber);
      if (!phone) {
        res.status(400).json({ error: 'whatsappNumber is not a valid phone number' });
        return;
      }
      const parent = await prisma.parent.upsert({
        where: { whatsappNumber: phone },
        update: {},
        create: { fullName: parentName, whatsappNumber: phone },
      });
      resolvedParentId = parent.id;
    }

    const lead = await prisma.lead.create({
      data: { parentId: resolvedParentId, ...leadData },
      include: { parent: true },
    });

    res.status(201).json(lead);
  } catch (error) {
    logger.error('createLead error', { error });
    res.status(500).json({ error: 'Failed to create lead' });
  }
}

export async function updateLeadStatus(req: Request, res: Response): Promise<void> {
  const parsed = UpdateStatusSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }

  try {
    if (parsed.data.status === 'lost') {
      await markLost(req, res, parsed.data.agentId, parsed.data.reason);
      return;
    }
    const lead = await prisma.lead.update({
      where: { id: req.params.id },
      data: { status: parsed.data.status },
    });
    res.json(lead);
  } catch (error) {
    if (isNotFound(error)) {
      res.status(404).json({ error: 'Lead not found' });
      return;
    }
    logger.error('updateLeadStatus error', { error });
    res.status(500).json({ error: 'Failed to update lead status' });
  }
}

/**
 * qualifyLead — called by the Admissions AI tool `qualify_lead`.
 * Fills in academic details and sets status to 'qualified'.
 */
export async function qualifyLead(req: Request, res: Response): Promise<void> {
  const parsed = QualifyLeadSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }

  const { agentId, ...qualificationData } = parsed.data;

  try {
    const lead = await prisma.lead.update({
      where: { id: req.params.id },
      data: { status: 'qualified', ...qualificationData, assignedAgentId: agentId },
    });

    // Log the AI action per Security_Plan.md §5.1
    await aiActivityLogService.log({
      agentId,
      targetId: lead.id,
      actionType: 'qualify_lead',
      payload: { leadId: lead.id, qualificationData },
      status: 'success',
    });

    res.json(lead);
  } catch (error) {
    if (isNotFound(error)) {
      res.status(404).json({ error: 'Lead not found' });
      return;
    }
    logger.error('qualifyLead error', { error });
    await aiActivityLogService.log({
      agentId: parsed.data.agentId,
      targetId: req.params.id,
      actionType: 'qualify_lead',
      payload: { error: String(error) },
      status: 'failure',
    });
    res.status(500).json({ error: 'Failed to qualify lead' });
  }
}

export async function deleteLead(req: Request, res: Response): Promise<void> {
  try {
    await markLost(req, res);
  } catch (error) {
    logger.error('deleteLead error', { error });
    res.status(500).json({ error: 'Failed to delete lead' });
  }
}
