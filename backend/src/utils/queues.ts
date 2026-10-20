import { Queue, Worker, Job, UnrecoverableError } from 'bullmq';
import { Prisma } from '@prisma/client';
import { queueRedis } from '../utils/redis';
import { prisma } from '../utils/database';
import { messagingAdapter, PartialSendError, SentPart } from '../services/messaging.adapter';
import { logger } from '../utils/logger';
import { normalizePhone } from '../utils/phone';
import { aiActivityLogService } from '../services/ai-activity-log.service';

// ── Job Type Definitions ──────────────────────────────────────

export interface SendWhatsAppJob {
  to: string;
  text: string;
  mediaUrl?: string;
  mediaType?: 'image' | 'document' | 'audio' | 'video';
  agentId: string;
  targetId?: string;
  /** Optional conversation context. When omitted, the worker resolves the parent by phone number
   *  and treats `targetId` as a lead id if such a lead exists. */
  parentId?: string;
  leadId?: string;
  studentId?: string;
  /** Free-form tag for the kind of message (e.g. 'manual', 'reminder'); 'opt_out_confirmation' bypasses the opt-out check. */
  messageKind?: string;
  /** Id of a caller-created outbound Message row (status 'queued'). The worker updates this row
   *  (sent / failed:<reason>) instead of writing a separate one. */
  messageId?: string;
}

/** The only message kind allowed to reach a parent who has opted out (the STOP / START confirmation). */
export const OPT_OUT_CONFIRMATION_KIND = 'opt_out_confirmation';

// ── Queue Definitions ─────────────────────────────────────────

export const whatsappQueue = new Queue<SendWhatsAppJob>('whatsapp-messages', {
  connection: queueRedis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: 100,
    removeOnFail: 500,
  },
});

// ── Message persistence ───────────────────────────────────────

interface MessageContext {
  parentId: string | null;
  leadId: string | null;
  studentId: string | null;
  optedOut: boolean;
}

/** Marker for failures the processor already recorded itself and must not be retried. */
class RecordedSendFailure extends UnrecoverableError {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'RecordedSendFailure';
  }
}

async function resolveContext(job: SendWhatsAppJob, phone: string | null): Promise<MessageContext> {
  const parent = job.parentId
    ? await prisma.parent.findUnique({ where: { id: job.parentId } })
    : phone
      ? await prisma.parent.findUnique({ where: { whatsappNumber: phone } })
      : null;

  let leadId = job.leadId ?? null;
  let parentId = parent?.id ?? null;
  if (!leadId && job.targetId) {
    const lead = await prisma.lead.findUnique({ where: { id: job.targetId }, select: { id: true, parentId: true } });
    if (lead && (!parentId || lead.parentId === parentId)) {
      leadId = lead.id;
      parentId = parentId ?? lead.parentId;
    }
  }

  return { parentId, leadId, studentId: job.studentId ?? null, optedOut: parent?.optedOut ?? false };
}

export interface OutboundRecord {
  parentId: string | null;
  leadId: string | null;
  studentId: string | null;
  body: string;
  status: string;
  externalId?: string | null;
  agentId?: string | null;
}

/**
 * Writes an outbound Message row. If the gateway's own `SendMessage` webhook already stored the same
 * provider id, the row is enriched with the context we know instead of duplicated.
 */
export async function recordOutboundMessage(rec: OutboundRecord): Promise<void> {
  const data = {
    parentId: rec.parentId,
    leadId: rec.leadId,
    studentId: rec.studentId,
    direction: 'outbound' as const,
    channel: 'whatsapp' as const,
    body: rec.body,
    status: rec.status,
    agentId: rec.agentId ?? null,
  };
  if (!rec.externalId) {
    await prisma.message.create({ data });
    return;
  }
  const update = {
    status: rec.status,
    ...(rec.parentId ? { parentId: rec.parentId } : {}),
    ...(rec.leadId ? { leadId: rec.leadId } : {}),
    ...(rec.studentId ? { studentId: rec.studentId } : {}),
    ...(rec.agentId ? { agentId: rec.agentId } : {}),
  };
  try {
    await prisma.message.upsert({ where: { externalId: rec.externalId }, create: { ...data, externalId: rec.externalId }, update });
  } catch (err) {
    // Lost the create race against the webhook: the row exists now, so just enrich it.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      await prisma.message.update({ where: { externalId: rec.externalId }, data: update });
      return;
    }
    throw err;
  }
}

function hasContext(ctx: MessageContext): boolean {
  return !!(ctx.parentId || ctx.leadId || ctx.studentId);
}

/** Persistence must never turn a delivered message into a retried (duplicate) one. */
async function safeRecord(rec: OutboundRecord): Promise<void> {
  try {
    await recordOutboundMessage(rec);
  } catch (err: any) {
    logger.error('Failed to persist outbound WhatsApp message', { error: err.message, externalId: rec.externalId });
  }
}

/** Manual staff messages are stored with a null agentId (the staff member lives in the audit log). */
function messageAgent(job: SendWhatsAppJob): string | null {
  return job.messageKind === 'manual' ? null : job.agentId;
}

/**
 * Marks the caller's pre-created row as failed. Only touches rows still 'queued' so a row that was
 * already delivered is never downgraded. Returns false when there is no such row to update.
 */
async function failRow(messageId: string, reason: string): Promise<boolean> {
  try {
    const res = await prisma.message.updateMany({
      where: { id: messageId, status: 'queued' },
      data: { status: `failed:${reason}`.slice(0, 30) },
    });
    if (res.count > 0) return true;
    return (await prisma.message.count({ where: { id: messageId } })) > 0;
  } catch (err: any) {
    logger.error('Failed to mark outbound WhatsApp message as failed', { messageId, error: err.message });
    return true; // do not fall back to creating a duplicate row
  }
}

/**
 * Marks the caller's pre-created row as sent with the first provider message id. If the gateway's own
 * SendMessage webhook echo already stored that id, the echo row is kept (enriched) and the placeholder removed,
 * so the history never holds two rows for one message. Returns false when the row no longer exists.
 */
async function sentRow(messageId: string, part: SentPart | undefined, ctx: MessageContext, job: SendWhatsAppJob): Promise<boolean> {
  try {
    await prisma.message.update({
      where: { id: messageId },
      data: { status: 'sent', ...(part ? { externalId: part.id } : {}) },
    });
    return true;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === 'P2025') return false;
      if (err.code === 'P2002' && part) {
        await safeRecord({ ...ctx, body: part.text, status: 'sent', externalId: part.id, agentId: messageAgent(job) });
        await prisma.message.deleteMany({ where: { id: messageId, status: 'queued' } }).catch(() => undefined);
        return true;
      }
    }
    logger.error('Failed to mark outbound WhatsApp message as sent', { messageId, error: (err as Error).message });
    return true;
  }
}

async function recordSent(ctx: MessageContext, job: SendWhatsAppJob, parts: SentPart[]): Promise<void> {
  let rest = parts;
  if (job.messageId && parts.length > 0) {
    if (await sentRow(job.messageId, parts[0], ctx, job)) rest = parts.slice(1);
  } else if (job.messageId && parts.length === 0) {
    await sentRow(job.messageId, undefined, ctx, job);
  }
  if (!hasContext(ctx)) return;
  for (const part of rest) {
    await safeRecord({ ...ctx, body: part.text, status: 'sent', externalId: part.id, agentId: messageAgent(job) });
  }
}

async function recordFailed(ctx: MessageContext, job: SendWhatsAppJob, reason: string, body = job.text): Promise<void> {
  if (job.messageId && (await failRow(job.messageId, reason))) return;
  if (!hasContext(ctx)) return;
  await safeRecord({ ...ctx, body, status: `failed:${reason}`.slice(0, 30), agentId: messageAgent(job) });
}

// ── Worker: WhatsApp Messages ─────────────────────────────────

export async function processWhatsAppJob(job: Job<SendWhatsAppJob>): Promise<void> {
  const data = job.data;
  const { text, mediaUrl, agentId, targetId } = data;
  const phone = normalizePhone(data.to);
  const ctx = await resolveContext(data, phone);
  logger.debug(`WhatsApp job ${job.id}: sending to ${phone ?? data.to}`);

  if (!phone) {
    await recordFailed(ctx, data, 'invalid_phone');
    await aiActivityLogService.log({ agentId, targetId, actionType: 'sent_whatsapp_message', payload: { to: data.to, error: 'invalid_phone' }, status: 'failure' });
    throw new RecordedSendFailure('invalid_phone');
  }

  if (ctx.optedOut && data.messageKind !== OPT_OUT_CONFIRMATION_KIND) {
    await recordFailed(ctx, data, 'opted_out');
    await aiActivityLogService.log({ agentId, targetId, actionType: 'sent_whatsapp_message', payload: { to: phone, error: 'opted_out' }, status: 'failure' });
    logger.warn(`WhatsApp job ${job.id} refused: parent has opted out`, { to: phone });
    throw new RecordedSendFailure('opted_out');
  }

  let parts: SentPart[];
  try {
    const res = await messagingAdapter.send({ to: phone, text, mediaUrl, mediaType: data.mediaType });
    parts = res.parts;
  } catch (err) {
    if (err instanceof PartialSendError) {
      // Some bubbles are already out: record them, mark the rest failed, and do not retry (would duplicate).
      await recordSent(ctx, data, err.sent);
      if (data.messageId && err.sent.length > 0) {
        // The caller's row now represents the first delivered bubble; the undelivered remainder gets its own row.
        await recordFailed(ctx, { ...data, messageId: undefined }, 'partial_send', err.unsent.join('\n\n'));
      } else {
        await recordFailed(ctx, data, 'partial_send', err.unsent.join('\n\n'));
      }
      await aiActivityLogService.log({ agentId, targetId, actionType: 'sent_whatsapp_message', payload: { to: phone, error: err.message, sentParts: err.sent.length, unsentParts: err.unsent.length }, status: 'failure' });
      throw new RecordedSendFailure(`partial_send: ${err.message}`);
    }
    throw err;
  }

  await recordSent(ctx, data, parts);
  await aiActivityLogService.log({
    agentId,
    targetId,
    actionType: 'sent_whatsapp_message',
    payload: { to: phone, preview: text.slice(0, 100) },
    status: 'success',
  });
}

/** BullMQ 'failed' handler: records the permanent failure only after the final attempt (intermediate retries stay 'queued'). */
export async function handleWhatsAppJobFailed(job: Job<SendWhatsAppJob> | undefined, err: Error): Promise<void> {
  if (!job) {
    logger.error('WhatsApp job failed (job lost)', { error: err.message });
    return;
  }
  if (err instanceof RecordedSendFailure) {
    logger.error(`WhatsApp job ${job.id} failed permanently`, { error: err.message });
    return;
  }
  const finalAttempt = job.attemptsMade >= (job.opts?.attempts ?? 1);
  logger.error(`WhatsApp job ${job.id} failed (attempt ${job.attemptsMade}/${job.opts?.attempts ?? 1})`, { error: err.message });
  if (!finalAttempt) return;

  try {
    const ctx = await resolveContext(job.data, normalizePhone(job.data.to));
    await recordFailed(ctx, job.data, 'send_error');
  } catch (e: any) {
    logger.error('Failed to record failed WhatsApp message', { error: e.message });
  }
  await aiActivityLogService.log({
    agentId: job.data.agentId,
    targetId: job.data.targetId,
    actionType: 'sent_whatsapp_message',
    payload: { error: err.message },
    status: 'failure',
  });
}

export function startWhatsAppWorker(): Worker<SendWhatsAppJob> {
  const worker = new Worker<SendWhatsAppJob>('whatsapp-messages', processWhatsAppJob, {
    connection: queueRedis,
    concurrency: 5, // Process up to 5 messages concurrently
  });

  worker.on('failed', (job, err) => handleWhatsAppJobFailed(job, err));

  worker.on('error', (err) => logger.error('WhatsApp worker error', { error: err.message }));

  logger.info('WhatsApp message worker started');
  return worker;
}

// ── Convenience helpers ───────────────────────────────────────

export async function enqueueWhatsApp(data: SendWhatsAppJob, delayMs = 0): Promise<void> {
  await whatsappQueue.add('send', data, { delay: delayMs });
}
