import { z } from 'zod';
import { Prisma, Approval, ApprovalRisk, ApprovalStatus, UserRole } from '@prisma/client';
import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { can } from '../utils/permissions';
import { aiActivityLogService } from './ai-activity-log.service';
import { notifyParent } from './notify.service';
import { enqueueWhatsApp } from '../utils/queues';

/**
 * Human-in-the-loop approvals (Security_Plan.md §4). Agents (and non-admin users)
 * never perform guarded actions directly; they file an Approval row. A human with
 * the right permission decides it and, on approval, the matching executor runs
 * inside a transaction and the outcome is written back to the same row.
 */

export class ApprovalError extends Error {
  constructor(public readonly status: 400 | 403 | 404 | 409, message: string) {
    super(message);
    this.name = 'ApprovalError';
  }
}

export interface RequestApprovalInput {
  agentId: string;
  actionType: string;
  title: string;
  reason?: string;
  payload: Record<string, unknown>;
  targetId?: string;
  risk?: ApprovalRisk;
}

export interface Decider {
  userId: string;
  role: UserRole;
}

type Tx = Prisma.TransactionClient;

interface OutboundMessage {
  to: string;
  text: string;
  targetId?: string;
  /** Pre-created queued Message row the worker should update. */
  messageId?: string;
  /** Parent and address for the same message by email */
  parentId?: string;
  leadId?: string;
  email?: string | null;
}

interface ExecutorOutput {
  result: Record<string, unknown>;
  /** WhatsApp sends, enqueued only after the transaction commits. */
  outbox?: OutboundMessage[];
}

type Executor = (tx: Tx, approval: Approval) => Promise<ExecutorOutput>;

// ── Payload schemas ───────────────────────────────────────────

const LeadLostPayload = z.object({ leadId: z.string().uuid() });
const DiscountPayload = z.object({ leadId: z.string().uuid(), text: z.string().min(1).max(2000) });
const RefundPayload = z.object({
  paymentId: z.string().uuid().optional(),
  leadId: z.string().uuid().optional(),
  studentId: z.string().uuid().optional(),
  amount: z.number().positive().optional(),
  note: z.string().max(2000).optional(),
});
const BroadcastPayload = z.object({
  leadIds: z.array(z.string().uuid()).min(1).max(200),
  text: z.string().min(1).max(2000),
});
const CertificatePayload = z.object({
  studentId: z.string().uuid(),
  certificateType: z.string().max(100).optional(),
});

// ── Executors (keyed by actionType) ───────────────────────────

/** Persists the outbound row (queued) that the outbox send will deliver. */
async function recordOutbound(tx: Tx, approval: Approval, lead: { id: string; parentId: string }, text: string) {
  const row = await tx.message.create({
    data: {
      leadId: lead.id,
      parentId: lead.parentId,
      direction: 'outbound',
      channel: 'whatsapp',
      body: text,
      status: 'queued',
      agentId: approval.agentId,
    },
  });
  return row.id;
}

const executors: Record<string, Executor> = {
  'lead.mark_lost': async (tx, approval) => {
    const { leadId } = LeadLostPayload.parse(approval.payload);
    const before = await tx.lead.findUnique({ where: { id: leadId }, select: { status: true } });
    if (!before) throw new Error(`Lead ${leadId} not found`);
    await tx.lead.update({ where: { id: leadId }, data: { status: 'lost' } });
    return { result: { leadId, previousStatus: before.status, status: 'lost' } };
  },

  'lead.discount_offer': async (tx, approval) => {
    const { leadId, text } = DiscountPayload.parse(approval.payload);
    const lead = await tx.lead.findUnique({ where: { id: leadId }, include: { parent: true } });
    if (!lead) throw new Error(`Lead ${leadId} not found`);
    if (lead.parent.optedOut) throw new Error('Parent has opted out of messages; offer not sent');
    const messageId = await recordOutbound(tx, approval, lead, text);
    return {
      result: { leadId, to: lead.parent.whatsappNumber, queued: true },
      outbox: [{ to: lead.parent.whatsappNumber, text, targetId: lead.id, messageId, parentId: lead.parentId, leadId: lead.id, email: lead.parent.email }],
    };
  },

  // Record only: no money movement exists in this system.
  'payment.refund': async (tx, approval) => {
    const p = RefundPayload.parse(approval.payload);
    const note = `Refund approved (record only, no funds moved)${p.amount ? ` amount=${p.amount}` : ''}${p.paymentId ? ` payment=${p.paymentId}` : ''}${p.note ? `: ${p.note}` : ''}`;
    await tx.message.create({
      data: {
        leadId: p.leadId,
        studentId: p.studentId,
        direction: 'outbound',
        channel: 'system',
        body: note,
        status: 'recorded',
        agentId: approval.agentId,
      },
    });
    return { result: { recorded: true, moneyMoved: false, note } };
  },

  'message.broadcast': async (tx, approval) => {
    const { leadIds, text } = BroadcastPayload.parse(approval.payload);
    const uniqueIds = [...new Set(leadIds)];
    const leads = await tx.lead.findMany({ where: { id: { in: uniqueIds } }, include: { parent: true } });
    const found = new Set(leads.map((l) => l.id));
    const missing = uniqueIds.filter((id) => !found.has(id));
    const skippedOptedOut: string[] = [];
    const outbox: OutboundMessage[] = [];
    const seenNumbers = new Set<string>();
    for (const lead of leads) {
      if (lead.parent.optedOut) {
        skippedOptedOut.push(lead.id);
        continue;
      }
      // One parent can own several leads; message each number once.
      if (seenNumbers.has(lead.parent.whatsappNumber)) continue;
      seenNumbers.add(lead.parent.whatsappNumber);
      const messageId = await recordOutbound(tx, approval, lead, text);
      outbox.push({ to: lead.parent.whatsappNumber, text, targetId: lead.id, messageId, parentId: lead.parentId, leadId: lead.id, email: lead.parent.email });
    }
    if (outbox.length === 0) throw new Error('No deliverable recipients (all opted out or not found)');
    return { result: { queued: outbox.length, skippedOptedOut, missing }, outbox };
  },

  'student.certificate': async (tx, approval) => {
    const { studentId, certificateType } = CertificatePayload.parse(approval.payload);
    const student = await tx.student.findUnique({ where: { id: studentId }, select: { id: true, fullName: true } });
    if (!student) throw new Error(`Student ${studentId} not found`);
    return { result: { studentId, certificateType: certificateType ?? 'general', issued: false, loggedOnly: true } };
  },
};

export const approvalService = {
  /** Action types that have an executor; anything else cannot be approved into effect. */
  supportedActions(): string[] {
    return Object.keys(executors);
  },

  async requestApproval(input: RequestApprovalInput): Promise<Approval> {
    if (!executors[input.actionType]) {
      throw new ApprovalError(400, `Unsupported approval action '${input.actionType}'`);
    }
    const approval = await prisma.approval.create({
      data: {
        agentId: input.agentId,
        actionType: input.actionType,
        title: input.title,
        reason: input.reason,
        payload: input.payload as Prisma.InputJsonValue,
        targetId: input.targetId,
        risk: input.risk ?? 'medium',
      },
    });
    await aiActivityLogService.log({
      agentId: input.agentId,
      targetId: input.targetId,
      actionType: 'approval_requested',
      payload: { approvalId: approval.id, approvalAction: input.actionType, risk: approval.risk },
      status: 'pending',
    });
    return approval;
  },

  /** Returns the open approval for an action+target, so repeated requests do not pile up. */
  async findPending(actionType: string, targetId: string): Promise<Approval | null> {
    return prisma.approval.findFirst({ where: { actionType, targetId, status: 'pending' } });
  },

  async listApprovals(status: ApprovalStatus | 'all' = 'pending', limit = 100): Promise<Approval[]> {
    return prisma.approval.findMany({
      where: status === 'all' ? {} : { status },
      orderBy: { createdAt: status === 'pending' ? 'asc' : 'desc' },
      take: limit,
    });
  },

  async decideApproval(
    id: string,
    decision: 'approved' | 'rejected',
    user: Decider,
    note?: string
  ): Promise<Approval> {
    const existing = await prisma.approval.findUnique({ where: { id } });
    if (!existing) throw new ApprovalError(404, 'Approval not found');

    const needed = existing.risk === 'high' ? 'approvals:decide_high_risk' : 'approvals:decide';
    if (!can(user.role, needed)) {
      throw new ApprovalError(403, `Deciding a ${existing.risk}-risk approval requires the '${needed}' permission`);
    }

    // Atomic claim: only one concurrent decider can move it out of 'pending'.
    const claim = await prisma.approval.updateMany({
      where: { id, status: 'pending' },
      data: { status: decision, decidedById: user.userId, decidedAt: new Date(), decisionNote: note ?? null },
    });
    if (claim.count === 0) throw new ApprovalError(409, 'Approval has already been decided');

    if (decision === 'rejected') {
      await aiActivityLogService.log({
        agentId: existing.agentId,
        targetId: existing.targetId ?? undefined,
        actionType: 'approval_rejected',
        payload: { approvalId: id, approvalAction: existing.actionType, decidedBy: user.userId, note },
        status: 'success',
      });
      return prisma.approval.findUniqueOrThrow({ where: { id } });
    }

    return this.execute(id, user);
  },

  /** Runs the executor for an approved row; marks it executed or failed. */
  async execute(id: string, user: Decider): Promise<Approval> {
    const approval = await prisma.approval.findUniqueOrThrow({ where: { id } });
    const executor = executors[approval.actionType];
    const logBase = {
      agentId: approval.agentId,
      targetId: approval.targetId ?? undefined,
    };

    try {
      if (!executor) throw new Error(`No executor registered for '${approval.actionType}'`);

      const out = await prisma.$transaction(async (tx) => {
        const o = await executor(tx, approval);
        await tx.approval.update({
          where: { id },
          data: { status: 'executed', result: o.result as Prisma.InputJsonValue },
        });
        return o;
      });

      // Sends happen after commit so a rolled-back transaction never messages a parent.
      const sendErrors: string[] = [];
      for (const m of out.outbox ?? []) {
        try {
          await enqueueWhatsApp({ to: m.to, text: m.text, agentId: approval.agentId, targetId: m.targetId, messageId: m.messageId });
          // Same approved message by email (its own Message row; never blocks the WhatsApp send)
          if (m.parentId && m.email) {
            await notifyParent({
              parent: { id: m.parentId, whatsappNumber: m.to, email: m.email, optedOut: false },
              leadId: m.leadId,
              agentId: approval.agentId,
              targetId: m.targetId,
              email: {
                kind: 'general',
                subject: 'A message from E-Kalavya',
                title: 'A message from E-Kalavya',
                paragraphs: m.text.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean),
              },
              idempotencyKey: `approval-${id}-${m.parentId}`,
            }).catch((e: Error) => logger.error('Approval outbox: email failed', { error: e.message }));
          }
        } catch (err) {
          if (m.messageId) await prisma.message.update({ where: { id: m.messageId }, data: { status: 'failed:enqueue' } }).catch(() => undefined);
          sendErrors.push(`${m.targetId ?? m.to}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (sendErrors.length > 0) {
        await prisma.approval.update({
          where: { id },
          data: {
            status: 'failed',
            result: { ...out.result, error: 'Action applied but message enqueue failed', sendErrors },
          },
        });
        await aiActivityLogService.log({
          ...logBase,
          actionType: `approval_executed_${approval.actionType}`,
          payload: { approvalId: id, decidedBy: user.userId, sendErrors },
          status: 'failure',
        });
      } else {
        await aiActivityLogService.log({
          ...logBase,
          actionType: `approval_executed_${approval.actionType}`,
          payload: { approvalId: id, decidedBy: user.userId, result: out.result },
          status: 'success',
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Approval ${id} execution failed`, { error: message });
      await prisma.approval.update({ where: { id }, data: { status: 'failed', result: { error: message } } });
      await aiActivityLogService.log({
        ...logBase,
        actionType: `approval_executed_${approval.actionType}`,
        payload: { approvalId: id, decidedBy: user.userId, error: message },
        status: 'failure',
      });
    }

    return prisma.approval.findUniqueOrThrow({ where: { id } });
  },
};

export const requestApproval = (input: RequestApprovalInput) => approvalService.requestApproval(input);
export const listApprovals = (status?: ApprovalStatus | 'all') => approvalService.listApprovals(status);
export const decideApproval = (id: string, decision: 'approved' | 'rejected', user: Decider, note?: string) =>
  approvalService.decideApproval(id, decision, user, note);
