import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';

const enqueueWhatsApp = vi.fn();
vi.mock('../utils/queues', () => ({ enqueueWhatsApp: (...a: unknown[]) => enqueueWhatsApp(...a) }));

import { prisma } from '../utils/database';
import { reminderService } from './reminder.service';

const sfx = String(Date.now()).slice(-9);
const phoneA = `91${sfx}1`.slice(0, 14);
const phoneB = `91${sfx}2`.slice(0, 14);
let parentA: string, parentB: string;
const leadIds: string[] = [];
const apptIds: string[] = [];
// A time ~24h from now, jittered per test file run so rows stay inside the 23-25h window
const in24h = () => new Date(Date.now() + 24 * 3600 * 1000);

const sentTo = (phone: string) => enqueueWhatsApp.mock.calls.filter((c) => (c[0] as any).to === phone);

beforeAll(async () => {
  parentA = (await prisma.parent.create({ data: { fullName: 'Rem A', whatsappNumber: phoneA } })).id;
  parentB = (await prisma.parent.create({ data: { fullName: 'Rem B', whatsappNumber: phoneB, optedOut: true } })).id;
});
beforeEach(() => enqueueWhatsApp.mockReset());
afterAll(async () => {
  await prisma.aiActivityLog.deleteMany({ where: { targetId: { in: apptIds } } });
  await prisma.appointment.deleteMany({ where: { id: { in: apptIds } } });
  await prisma.lead.deleteMany({ where: { id: { in: leadIds } } });
  await prisma.parent.deleteMany({ where: { id: { in: [parentA, parentB] } } });
});

describe('reminderService.processDemoReminders', () => {
  it('reminds per appointment (two demos for one lead), uses IST wording, skips opted-out, and never repeats', async () => {
    const lead = await prisma.lead.create({ data: { parentId: parentA, status: 'demo_scheduled' } });
    const optLead = await prisma.lead.create({ data: { parentId: parentB, status: 'demo_scheduled' } });
    leadIds.push(lead.id, optLead.id);
    const t = in24h();
    const a1 = await prisma.appointment.create({ data: { leadId: lead.id, scheduledAt: t } });
    const a2 = await prisma.appointment.create({ data: { leadId: lead.id, scheduledAt: new Date(t.getTime() + 30 * 60000) } });
    const ob = await prisma.appointment.create({ data: { leadId: optLead.id, scheduledAt: t } });
    apptIds.push(a1.id, a2.id, ob.id);

    const first = await reminderService.processDemoReminders();
    expect(sentTo(phoneA)).toHaveLength(2);
    expect(sentTo(phoneB)).toHaveLength(0);
    expect(first.skippedOptedOut).toBeGreaterThanOrEqual(1);
    expect((sentTo(phoneA)[0][0] as any).text).toContain('IST');
    expect(sentTo(phoneA).map((c) => (c[0] as any).targetId).sort()).toEqual([a1.id, a2.id].sort());

    enqueueWhatsApp.mockClear();
    await reminderService.processDemoReminders();
    expect(sentTo(phoneA)).toHaveLength(0);
  });

  it('logs enqueue failures, counts them, and retries on the next scan', async () => {
    const lead = await prisma.lead.create({ data: { parentId: parentA, status: 'demo_scheduled' } });
    leadIds.push(lead.id);
    const appt = await prisma.appointment.create({ data: { leadId: lead.id, scheduledAt: new Date(Date.now() + 60 * 60000) } }); // 1h window
    apptIds.push(appt.id);

    enqueueWhatsApp.mockRejectedValue(new Error('queue down'));
    const failed = await reminderService.processDemoReminders();
    expect(failed.failed).toBeGreaterThanOrEqual(1);
    const failLog = await prisma.aiActivityLog.findFirst({ where: { targetId: appt.id, actionType: 'demo_reminder_1h' } });
    expect(failLog?.status).toBe('failure');

    enqueueWhatsApp.mockReset();
    await reminderService.processDemoReminders();
    expect(sentTo(phoneA).some((c) => (c[0] as any).targetId === appt.id)).toBe(true);
  });
});
