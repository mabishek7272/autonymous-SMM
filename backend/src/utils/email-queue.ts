import { Queue, Worker, Job, UnrecoverableError } from 'bullmq';
import { queueRedis } from './redis';
import { prisma } from './database';
import { logger } from './logger';
import { sendViaResend, type EmailKind } from '../services/email.service';
import { aiActivityLogService } from '../services/ai-activity-log.service';

export interface SendEmailJob {
  to: string;
  kind: EmailKind;
  subject: string;
  html: string;
  text: string;
  agentId: string;
  targetId?: string;
  /** Pre-created Message row (channel 'email') to keep in step: queued -> sent / failed */
  messageId?: string;
  idempotencyKey?: string;
}

export const emailQueue = new Queue<SendEmailJob>('email-messages', {
  connection: queueRedis,
  defaultJobOptions: {
    attempts: 4,
    backoff: { type: 'exponential', delay: 10_000 },
    removeOnComplete: 200,
    removeOnFail: 500,
  },
});

/** BullMQ rejects ':' in custom job ids, so the idempotency key is sanitised into one. */
export function emailJobId(idempotencyKey: string): string {
  return `email-${idempotencyKey.replace(/[^A-Za-z0-9_.-]/g, '-')}`.slice(0, 200);
}

export async function enqueueEmail(data: SendEmailJob): Promise<void> {
  await emailQueue.add('send', data, data.idempotencyKey ? { jobId: emailJobId(data.idempotencyKey) } : undefined);
}

export async function processEmailJob(job: Job<SendEmailJob>): Promise<void> {
  const d = job.data;
  const { id } = await sendViaResend({ to: d.to, kind: d.kind, subject: d.subject, html: d.html, text: d.text, idempotencyKey: d.idempotencyKey });
  if (d.messageId) {
    await prisma.message
      .updateMany({ where: { id: d.messageId, status: 'queued' }, data: { status: 'sent', externalId: `resend:${id}` } })
      .catch((e: Error) => logger.error('Failed to mark email sent', { error: e.message }));
  }
}

export async function handleEmailJobFailed(job: Job<SendEmailJob> | undefined, err: Error): Promise<void> {
  if (!job) {
    logger.error('Email job failed (job lost)', { error: err.message });
    return;
  }
  const permanent = err instanceof UnrecoverableError;
  const finalAttempt = permanent || job.attemptsMade >= (job.opts?.attempts ?? 1);
  logger.error(`Email job ${job.id} failed (attempt ${job.attemptsMade}/${job.opts?.attempts ?? 1})`, { to: job.data.to, error: err.message });
  if (!finalAttempt) return;
  if (job.data.messageId) {
    await prisma.message
      .updateMany({ where: { id: job.data.messageId, status: 'queued' }, data: { status: 'failed:email_error' } })
      .catch((e: Error) => logger.error('Failed to record failed email', { error: e.message }));
  }
  await aiActivityLogService.log({
    agentId: job.data.agentId,
    targetId: job.data.targetId,
    actionType: 'sent_email',
    payload: { to: job.data.to, subject: job.data.subject, error: err.message },
    status: 'failure',
  });
}

export function startEmailWorker(): Worker<SendEmailJob> {
  const worker = new Worker<SendEmailJob>('email-messages', processEmailJob, {
    connection: queueRedis,
    concurrency: 2,
    // Stay well under Resend's per-second request limit
    limiter: { max: 4, duration: 1000 },
  });
  worker.on('failed', (job, err) => void handleEmailJobFailed(job, err));
  worker.on('error', (err) => logger.error('Email worker error', { error: err.message }));
  logger.info('Email worker started');
  return worker;
}
