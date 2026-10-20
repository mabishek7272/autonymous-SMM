import { describe, it, expect, vi, beforeEach, beforeAll, afterAll, afterEach } from 'vitest';
import { prisma } from '../utils/database';

const q = vi.hoisted(() => ({ wa: vi.fn().mockResolvedValue(undefined), em: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../utils/queues', () => ({ enqueueWhatsApp: q.wa }));
vi.mock('../utils/email-queue', () => ({ enqueueEmail: q.em }));

import { notifyParent, notifyUser, delivered } from './notify.service';

const sfx = Date.now().toString(36);
const phone = `91${(Date.now() % 90000000) + 10000000}${Math.floor(Math.random() * 90 + 10)}`.slice(0, 12);
let parentId = '';
const saved = { ...process.env };
const spec = { kind: 'reports' as const, subject: 'Subject', title: 'Title', paragraphs: ['Body'] };

beforeAll(async () => {
  parentId = (await prisma.parent.create({ data: { fullName: `Notify ${sfx}`, whatsappNumber: phone, email: `parent-${sfx}@example.com` } })).id;
});
afterAll(async () => {
  await prisma.message.deleteMany({ where: { parentId } });
  await prisma.parent.delete({ where: { id: parentId } });
  await prisma.$disconnect();
});
beforeEach(() => { vi.clearAllMocks(); process.env.RESEND_API_KEY = 're_test'; });
afterEach(() => { process.env = { ...saved }; });

const parent = (o = {}) => ({ id: parentId, whatsappNumber: phone, email: `parent-${sfx}@example.com`, optedOut: false, ...o });

describe('notifyParent', () => {
  it('sends on both channels and records one Message row per channel', async () => {
    const r = await notifyParent({ parent: parent(), agentId: 'test', whatsapp: 'Hello by WhatsApp', email: spec, idempotencyKey: 'idem-1' });
    expect(r).toEqual({ whatsapp: 'queued', email: 'queued' });
    expect(delivered(r)).toBe(true);
    expect(q.wa).toHaveBeenCalledWith(expect.objectContaining({ to: phone, text: 'Hello by WhatsApp', messageId: expect.any(String) }));
    expect(q.em).toHaveBeenCalledWith(expect.objectContaining({ to: `parent-${sfx}@example.com`, kind: 'reports', subject: 'Subject', idempotencyKey: 'idem-1', messageId: expect.any(String) }));
    const rows = await prisma.message.findMany({ where: { parentId }, orderBy: { createdAt: 'asc' } });
    expect(rows.map((m) => [m.channel, m.status, m.subject])).toEqual([['whatsapp', 'queued', null], ['email', 'queued', 'Subject']]);
    expect(q.em.mock.calls[0][0].html).toContain('Title');
  });

  it('sends neither to an opted-out parent', async () => {
    const r = await notifyParent({ parent: parent({ optedOut: true }), agentId: 'test', whatsapp: 'x', email: spec });
    expect(r).toEqual({ whatsapp: 'opted_out', email: 'opted_out' });
    expect(q.wa).not.toHaveBeenCalled();
    expect(q.em).not.toHaveBeenCalled();
  });

  it('skips email (but still sends WhatsApp) when there is no usable address or email is off', async () => {
    expect((await notifyParent({ parent: parent({ email: null }), agentId: 't', whatsapp: 'x', email: spec })).email).toBe('no_address');
    expect((await notifyParent({ parent: parent({ email: 'not-an-email' }), agentId: 't', whatsapp: 'x', email: spec })).email).toBe('no_address');
    process.env.RESEND_API_KEY = '';
    const off = await notifyParent({ parent: parent(), agentId: 't', whatsapp: 'x', email: spec });
    expect(off).toEqual({ whatsapp: 'queued', email: 'disabled' });
    expect(q.em).not.toHaveBeenCalled();
    expect(q.wa).toHaveBeenCalledTimes(3);
  });

  it('one channel failing does not stop the other, and the failed row is marked', async () => {
    q.wa.mockRejectedValueOnce(new Error('redis down'));
    const r = await notifyParent({ parent: parent(), agentId: 't', whatsapp: 'x', email: spec });
    expect(r).toEqual({ whatsapp: 'failed', email: 'queued' });
    expect(delivered(r)).toBe(true);
    const wa = await prisma.message.findFirst({ where: { parentId, channel: 'whatsapp', status: 'failed:enqueue' } });
    expect(wa).not.toBeNull();

    q.em.mockRejectedValueOnce(new Error('redis down'));
    const r2 = await notifyParent({ parent: parent(), agentId: 't', whatsapp: 'x', email: spec });
    expect(r2).toEqual({ whatsapp: 'queued', email: 'failed' });
    expect(await prisma.message.findFirst({ where: { parentId, channel: 'email', status: 'failed:enqueue' } })).not.toBeNull();
  });

  it('only uses the channels it is asked for', async () => {
    expect(await notifyParent({ parent: parent(), agentId: 't', email: spec })).toEqual({ whatsapp: 'not_requested', email: 'queued' });
    expect(await notifyParent({ parent: parent(), agentId: 't', whatsapp: 'x' })).toEqual({ whatsapp: 'queued', email: 'not_requested' });
  });
});

describe('notifyUser', () => {
  it('emails and WhatsApps staff without writing parent Message rows', async () => {
    const before = await prisma.message.count();
    const r = await notifyUser({ user: { id: 'u1', email: 'teacher@example.com', phone: '919000000001' }, agentId: 't', whatsapp: 'Hi', email: spec });
    expect(r).toEqual({ whatsapp: 'queued', email: 'queued' });
    expect(await prisma.message.count()).toBe(before);
  });

  it('reports a missing phone or invalid email honestly', async () => {
    const r = await notifyUser({ user: { id: 'u1', email: 'bad', phone: null }, agentId: 't', whatsapp: 'Hi', email: spec });
    expect(r).toEqual({ whatsapp: 'no_address', email: 'no_address' });
  });
});
