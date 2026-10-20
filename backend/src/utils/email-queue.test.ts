import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { UnrecoverableError } from 'bullmq';
import { prisma } from './database';

const send = vi.hoisted(() => vi.fn());
vi.mock('../services/email.service', async (orig) => ({ ...(await orig<typeof import('../services/email.service')>()), sendViaResend: send }));

import { processEmailJob, handleEmailJobFailed, enqueueEmail, emailJobId, emailQueue, type SendEmailJob } from './email-queue';

const job = (data: Partial<SendEmailJob>, extra: Record<string, unknown> = {}) =>
  ({ id: 'j1', data: { to: 'a@b.co', kind: 'general', subject: 'S', html: '<p/>', text: 't', agentId: 'test', ...data }, attemptsMade: 1, opts: { attempts: 4 }, ...extra }) as any;

let rowId = '';
beforeAll(async () => {
  // a free-standing queued email row (no parent) is enough for the lifecycle
  rowId = (await prisma.message.create({ data: { direction: 'outbound', channel: 'email', subject: 'S', body: 't', status: 'queued', agentId: 'test' } })).id;
});
afterAll(async () => {
  await prisma.message.deleteMany({ where: { agentId: 'test', channel: 'email' } });
  await prisma.$disconnect();
});
beforeEach(async () => {
  vi.clearAllMocks();
  await prisma.message.update({ where: { id: rowId }, data: { status: 'queued', externalId: null } });
});

const status = async () => (await prisma.message.findUniqueOrThrow({ where: { id: rowId } }));

describe('email queue worker', () => {
  it('marks the Message row sent with the Resend id', async () => {
    send.mockResolvedValue({ id: 'em_42' });
    await processEmailJob(job({ messageId: rowId, idempotencyKey: 'k' }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: 'a@b.co', kind: 'general', idempotencyKey: 'k' }));
    expect(await status()).toMatchObject({ status: 'sent', externalId: 'resend:em_42' });
  });

  it('keeps the row queued while retries remain, and fails it on the final attempt', async () => {
    await handleEmailJobFailed(job({ messageId: rowId }, { attemptsMade: 2 }), new Error('429'));
    expect((await status()).status).toBe('queued');
    await handleEmailJobFailed(job({ messageId: rowId }, { attemptsMade: 4 }), new Error('still failing'));
    expect((await status()).status).toBe('failed:email_error');
  });

  it('fails immediately on a permanent error such as a rejected address', async () => {
    await handleEmailJobFailed(job({ messageId: rowId }, { attemptsMade: 1 }), new UnrecoverableError('invalid to address'));
    expect((await status()).status).toBe('failed:email_error');
  });

  it('never downgrades a row that was already sent', async () => {
    await prisma.message.update({ where: { id: rowId }, data: { status: 'sent' } });
    await handleEmailJobFailed(job({ messageId: rowId }, { attemptsMade: 4 }), new Error('late failure'));
    expect((await status()).status).toBe('sent');
  });
});

describe('enqueueEmail (real Redis queue)', () => {
  it('accepts an idempotency key with colons and dedupes a repeat of the same key', async () => {
    expect(emailJobId('absent-1:2026-10-17:b/1')).toBe('email-absent-1-2026-10-17-b-1');
    const key = `queue-test-${Date.now()}:with:colons`;
    const job = { to: 'a@b.co', kind: 'general' as const, subject: 'S', html: '<p/>', text: 't', agentId: 'test', idempotencyKey: key };
    // A paused queue keeps the job so the test never sends anything
    await emailQueue.pause();
    try {
      await enqueueEmail(job);
      await enqueueEmail(job);
      const found = await emailQueue.getJob(emailJobId(key));
      expect(found?.data.to).toBe('a@b.co');
      expect((await emailQueue.getJobs(['waiting', 'paused'])).filter((j) => j.id === emailJobId(key))).toHaveLength(1);
      await found?.remove();
    } finally {
      await emailQueue.resume();
    }
  });
});
