import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import { prisma } from './database';

vi.mock('../services/messaging.adapter', async (orig) => {
  const actual = await orig<typeof import('../services/messaging.adapter')>();
  return { ...actual, messagingAdapter: { send: vi.fn() } };
});
vi.mock('../services/ai-activity-log.service', () => ({ aiActivityLogService: { log: vi.fn().mockResolvedValue(undefined) } }));

import { messagingAdapter, PartialSendError } from '../services/messaging.adapter';
import { processWhatsAppJob, handleWhatsAppJobFailed, OPT_OUT_CONFIRMATION_KIND, SendWhatsAppJob } from './queues';

const sfx = Date.now().toString().slice(-8);
const phone = `9198${sfx.padStart(8, '0')}`;
const optedPhone = `9197${sfx.padStart(8, '0')}`;
let parentId: string, optedParentId: string, leadId: string;
const send = messagingAdapter.send as unknown as ReturnType<typeof vi.fn>;
const job = (data: SendWhatsAppJob) => ({ id: 'j1', data } as unknown as Job<SendWhatsAppJob>);

beforeAll(async () => {
  const p = await prisma.parent.create({ data: { fullName: `QTest ${sfx}`, whatsappNumber: phone } });
  parentId = p.id;
  leadId = (await prisma.lead.create({ data: { parentId, status: 'enquiry' } })).id;
  optedParentId = (await prisma.parent.create({ data: { fullName: `QOpt ${sfx}`, whatsappNumber: optedPhone, optedOut: true, optedOutAt: new Date() } })).id;
});
afterAll(async () => {
  await prisma.message.deleteMany({ where: { parentId: { in: [parentId, optedParentId] } } });
  await prisma.lead.deleteMany({ where: { parentId } });
  await prisma.parent.deleteMany({ where: { id: { in: [parentId, optedParentId] } } });
  await prisma.$disconnect();
});
beforeEach(() => { send.mockReset(); });

describe('processWhatsAppJob', () => {
  it('sends and persists an outbound Message, resolving context from phone + targetId', async () => {
    send.mockResolvedValue({ key: { id: 'X1' }, status: 'SENT', parts: [{ id: `ext-${sfx}-1`, text: 'hi there' }] });
    await processWhatsAppJob(job({ to: `+${phone}`, text: 'hi there', agentId: 'AdmissionsAI', targetId: leadId }));
    expect(send.mock.calls[0][0]).toMatchObject({ to: phone, text: 'hi there' });
    const m = await prisma.message.findUnique({ where: { externalId: `ext-${sfx}-1` } });
    expect(m).toMatchObject({ direction: 'outbound', status: 'sent', parentId, leadId, agentId: 'AdmissionsAI' });
  });

  it('enriches a row the webhook stored first instead of duplicating it', async () => {
    const id = `ext-${sfx}-2`;
    await prisma.message.create({ data: { parentId, direction: 'outbound', body: 'early', status: 'sent', externalId: id } });
    send.mockResolvedValue({ key: { id }, status: 'SENT', parts: [{ id, text: 'early' }] });
    await processWhatsAppJob(job({ to: phone, text: 'early', agentId: 'A', leadId }));
    expect(await prisma.message.count({ where: { externalId: id } })).toBe(1);
    expect((await prisma.message.findUnique({ where: { externalId: id } }))?.leadId).toBe(leadId);
  });

  it('stores manual messages with null agentId', async () => {
    send.mockResolvedValue({ key: { id: 'X' }, status: 'SENT', parts: [{ id: `ext-${sfx}-3`, text: 'manual' }] });
    await processWhatsAppJob(job({ to: phone, text: 'manual', agentId: 'staff:u1', leadId, messageKind: 'manual' }));
    expect((await prisma.message.findUnique({ where: { externalId: `ext-${sfx}-3` } }))?.agentId).toBeNull();
  });

  it('refuses opted-out parents, records failed:opted_out and never calls the gateway', async () => {
    await expect(processWhatsAppJob(job({ to: optedPhone, text: 'promo', agentId: 'A' }))).rejects.toThrow('opted_out');
    expect(send).not.toHaveBeenCalled();
    const m = await prisma.message.findFirst({ where: { parentId: optedParentId, body: 'promo' } });
    expect(m?.status).toBe('failed:opted_out');
  });

  it('lets the opt-out confirmation through', async () => {
    send.mockResolvedValue({ key: { id: 'X' }, status: 'SENT', parts: [{ id: `ext-${sfx}-4`, text: 'bye' }] });
    await processWhatsAppJob(job({ to: optedPhone, text: 'bye', agentId: 'A', messageKind: OPT_OUT_CONFIRMATION_KIND }));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('propagates gateway errors so BullMQ retries', async () => {
    send.mockImplementation(async () => { throw new Error('gateway down'); });
    await expect(processWhatsAppJob(job({ to: phone, text: 'x', agentId: 'A' }))).rejects.toThrow('gateway down');
  });

  it('records sent bubbles and a failed remainder on partial send, without retrying', async () => {
    send.mockImplementation(async () => { throw new PartialSendError('boom', [{ id: `ext-${sfx}-5`, text: 'one' }], ['two']); });
    await expect(processWhatsAppJob(job({ to: phone, text: 'one\n\ntwo', agentId: 'A', leadId }))).rejects.toThrow(/partial_send/);
    expect((await prisma.message.findUnique({ where: { externalId: `ext-${sfx}-5` } }))?.status).toBe('sent');
    expect((await prisma.message.findFirst({ where: { parentId, body: 'two' } }))?.status).toBe('failed:partial_send');
  });

  it('fails invalid numbers permanently', async () => {
    await expect(processWhatsAppJob(job({ to: 'garbage', text: 'x', agentId: 'A' }))).rejects.toThrow('invalid_phone');
    expect(send).not.toHaveBeenCalled();
  });
});

describe('caller-created rows (messageId)', () => {
  const mk = (body: string, p = parentId) =>
    prisma.message.create({ data: { parentId: p, direction: 'outbound', channel: 'whatsapp', body, status: 'queued', agentId: 'A' } });
  const countBody = (body: string) => prisma.message.count({ where: { body: { startsWith: body }, parentId: { in: [parentId, optedParentId] } } });

  it('success updates the caller row (sent + externalId) without creating another', async () => {
    const row = await mk(`mid-ok-${sfx}`);
    send.mockResolvedValue({ key: { id: 'X' }, status: 'SENT', parts: [{ id: `ext-${sfx}-m1`, text: `mid-ok-${sfx}` }] });
    await processWhatsAppJob(job({ to: phone, text: `mid-ok-${sfx}`, agentId: 'A', messageId: row.id }));
    const after = await prisma.message.findUnique({ where: { id: row.id } });
    expect(after).toMatchObject({ status: 'sent', externalId: `ext-${sfx}-m1` });
    expect(await countBody(`mid-ok-${sfx}`)).toBe(1);
  });

  it('keeps the row queued when no context exists and still updates it', async () => {
    const row = await prisma.message.create({ data: { direction: 'outbound', channel: 'whatsapp', body: `mid-noctx-${sfx}`, status: 'queued' } });
    send.mockResolvedValue({ key: { id: 'X' }, status: 'SENT', parts: [{ id: `ext-${sfx}-m2`, text: 'x' }] });
    await processWhatsAppJob(job({ to: '919000000001', text: `mid-noctx-${sfx}`, agentId: 'A', messageId: row.id }));
    expect((await prisma.message.findUnique({ where: { id: row.id } }))?.status).toBe('sent');
    await prisma.message.delete({ where: { id: row.id } });
  });

  it('does not duplicate when the gateway echo stored the provider id first', async () => {
    const row = await mk(`mid-echo-${sfx}`);
    const id = `ext-${sfx}-m3`;
    await prisma.message.create({ data: { direction: 'outbound', channel: 'whatsapp', body: `mid-echo-${sfx}`, status: 'sent', externalId: id } });
    send.mockResolvedValue({ key: { id }, status: 'SENT', parts: [{ id, text: `mid-echo-${sfx}` }] });
    await processWhatsAppJob(job({ to: phone, text: `mid-echo-${sfx}`, agentId: 'A', parentId, messageId: row.id }));
    expect(await prisma.message.count({ where: { externalId: id } })).toBe(1);
    expect(await prisma.message.findUnique({ where: { id: row.id } })).toBeNull();
    expect((await prisma.message.findUnique({ where: { externalId: id } }))?.parentId).toBe(parentId);
  });

  it('a later echo of the same id is deduped by externalId (row already updated)', async () => {
    const row = await mk(`mid-late-${sfx}`);
    const id = `ext-${sfx}-m4`;
    send.mockResolvedValue({ key: { id }, status: 'SENT', parts: [{ id, text: 'x' }] });
    await processWhatsAppJob(job({ to: phone, text: `mid-late-${sfx}`, agentId: 'A', messageId: row.id }));
    await expect(prisma.message.create({ data: { direction: 'outbound', channel: 'whatsapp', body: 'echo', status: 'sent', externalId: id } })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('multi-part success: first part updates the row, remaining parts get their own rows', async () => {
    const row = await mk(`mid-multi-${sfx}`);
    send.mockResolvedValue({ key: { id: 'X' }, status: 'SENT', parts: [{ id: `ext-${sfx}-m5a`, text: 'a' }, { id: `ext-${sfx}-m5b`, text: 'b' }] });
    await processWhatsAppJob(job({ to: phone, text: 'a\n\nb', agentId: 'A', messageId: row.id }));
    expect((await prisma.message.findUnique({ where: { id: row.id } }))?.externalId).toBe(`ext-${sfx}-m5a`);
    expect((await prisma.message.findUnique({ where: { externalId: `ext-${sfx}-m5b` } }))?.status).toBe('sent');
  });

  it('marks failed:opted_out and failed:invalid_phone on the caller row', async () => {
    const r1 = await mk(`mid-opt-${sfx}`, optedParentId);
    await expect(processWhatsAppJob(job({ to: optedPhone, text: `mid-opt-${sfx}`, agentId: 'A', messageId: r1.id }))).rejects.toThrow('opted_out');
    expect((await prisma.message.findUnique({ where: { id: r1.id } }))?.status).toBe('failed:opted_out');
    const r2 = await mk(`mid-bad-${sfx}`);
    await expect(processWhatsAppJob(job({ to: 'garbage', text: 'x', agentId: 'A', messageId: r2.id }))).rejects.toThrow('invalid_phone');
    expect((await prisma.message.findUnique({ where: { id: r2.id } }))?.status).toBe('failed:invalid_phone');
    expect(await countBody('mid-opt-')).toBe(1);
  });

  it('keeps the row queued on intermediate retries and marks failed after the final attempt', async () => {
    const row = await mk(`mid-retry-${sfx}`);
    const data: SendWhatsAppJob = { to: phone, text: `mid-retry-${sfx}`, agentId: 'A', parentId, messageId: row.id };
    send.mockImplementation(async () => { throw new Error('EVOLUTION_GO_API_KEY not configured'); });
    const mkJob = (attemptsMade: number) => ({ id: 'j2', data, attemptsMade, opts: { attempts: 3 } } as unknown as Job<SendWhatsAppJob>);
    for (const n of [1, 2]) {
      const j = mkJob(n);
      await expect(processWhatsAppJob(j)).rejects.toThrow();
      await handleWhatsAppJobFailed(j, new Error('boom'));
      expect((await prisma.message.findUnique({ where: { id: row.id } }))?.status).toBe('queued');
    }
    const last = mkJob(3);
    await expect(processWhatsAppJob(last)).rejects.toThrow();
    await handleWhatsAppJobFailed(last, new Error('boom'));
    expect((await prisma.message.findUnique({ where: { id: row.id } }))?.status).toBe('failed:send_error');
    expect(await countBody(`mid-retry-${sfx}`)).toBe(1);
  });

  it('never downgrades a row that was already sent', async () => {
    const row = await mk(`mid-sent-${sfx}`);
    await prisma.message.update({ where: { id: row.id }, data: { status: 'sent' } });
    await handleWhatsAppJobFailed({ id: 'j3', data: { to: phone, text: 'x', agentId: 'A', parentId, messageId: row.id }, attemptsMade: 3, opts: { attempts: 3 } } as unknown as Job<SendWhatsAppJob>, new Error('late'));
    expect((await prisma.message.findUnique({ where: { id: row.id } }))?.status).toBe('sent');
  });

  it('without messageId and without context nothing is created (unchanged behaviour)', async () => {
    send.mockResolvedValue({ key: { id: 'X' }, status: 'SENT', parts: [{ id: `ext-${sfx}-m9`, text: 'x' }] });
    await processWhatsAppJob(job({ to: '919000000002', text: `ctxless-${sfx}`, agentId: 'A' }));
    expect(await prisma.message.count({ where: { body: `ctxless-${sfx}` } })).toBe(0);
  });
});
