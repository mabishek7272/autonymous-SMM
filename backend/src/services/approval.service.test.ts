import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { UserRole } from '@prisma/client';
import { prisma } from '../utils/database';

vi.mock('../utils/queues', async (orig) => ({
  ...(await orig<typeof import('../utils/queues')>()),
  enqueueWhatsApp: vi.fn(async () => undefined),
}));

import { enqueueWhatsApp } from '../utils/queues';
import { approvalService, ApprovalError } from './approval.service';

const sfx = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const admin = { userId: randomUUID(), role: UserRole.admin };
const superadmin = { userId: randomUUID(), role: UserRole.superadmin };

const approvalIds: string[] = [];
const leadIds: string[] = [];
const parentIds: string[] = [];
let leadA: string; // normal parent
let leadOptOut: string;
let parentA: string;

async function mkParent(n: string, optedOut = false) {
  const p = await prisma.parent.create({
    data: { fullName: `AprTest ${n} ${sfx}`, whatsappNumber: `8${sfx}${n}`.slice(0, 20), optedOut },
  });
  parentIds.push(p.id);
  return p;
}
async function mkLead(parentId: string) {
  const l = await prisma.lead.create({ data: { parentId } });
  leadIds.push(l.id);
  return l;
}
async function mkApproval(actionType: string, payload: Record<string, unknown>, risk: 'low' | 'medium' | 'high' = 'medium', targetId?: string) {
  const a = await approvalService.requestApproval({ agentId: 'TestAgent', actionType, title: `t ${sfx}`, payload, risk, targetId });
  approvalIds.push(a.id);
  return a;
}

beforeAll(async () => {
  const pa = await mkParent('1');
  parentA = pa.id;
  leadA = (await mkLead(pa.id)).id;
  const po = await mkParent('2', true);
  leadOptOut = (await mkLead(po.id)).id;
});

afterAll(async () => {
  await prisma.aiActivityLog.deleteMany({ where: { OR: [{ targetId: { in: leadIds } }, { agentId: 'TestAgent' }] } });
  await prisma.message.deleteMany({ where: { OR: [{ leadId: { in: leadIds } }, { body: { contains: sfx } }] } });
  await prisma.approval.deleteMany({ where: { id: { in: approvalIds } } });
  await prisma.lead.deleteMany({ where: { id: { in: leadIds } } });
  await prisma.parent.deleteMany({ where: { id: { in: parentIds } } });
});

describe('approvalService', () => {
  it('rejects unsupported action types', async () => {
    await expect(approvalService.requestApproval({ agentId: 'TestAgent', actionType: 'nope', title: 'x', payload: {} })).rejects.toBeInstanceOf(ApprovalError);
  });

  it('lists pending rows and filters by status', async () => {
    const a = await mkApproval('lead.mark_lost', { leadId: leadA }, 'medium', leadA);
    const pending = await approvalService.listApprovals('pending', 500);
    expect(pending.some((p) => p.id === a.id)).toBe(true);
    const executed = await approvalService.listApprovals('executed', 500);
    expect(executed.some((p) => p.id === a.id)).toBe(false);
  });

  it('approving lead.mark_lost executes in the DB and is idempotent (409 on second decision)', async () => {
    const a = await mkApproval('lead.mark_lost', { leadId: leadA }, 'medium', leadA);
    const done = await approvalService.decideApproval(a.id, 'approved', admin, 'ok');
    expect(done.status).toBe('executed');
    expect(done.decidedById).toBe(admin.userId);
    expect((await prisma.lead.findUnique({ where: { id: leadA } }))!.status).toBe('lost');
    await expect(approvalService.decideApproval(a.id, 'approved', admin)).rejects.toMatchObject({ status: 409 });
    await expect(approvalService.decideApproval(a.id, 'rejected', superadmin)).rejects.toMatchObject({ status: 409 });
  });

  it('rejecting does not execute', async () => {
    const lead = await mkLead(parentA);
    const a = await mkApproval('lead.mark_lost', { leadId: lead.id }, 'medium', lead.id);
    const done = await approvalService.decideApproval(a.id, 'rejected', admin, 'no');
    expect(done.status).toBe('rejected');
    expect((await prisma.lead.findUnique({ where: { id: lead.id } }))!.status).toBe('enquiry');
  });

  it('high-risk needs decide_high_risk (admin 403, superadmin ok) and 403 leaves it pending', async () => {
    const a = await mkApproval('payment.refund', { amount: 100, note: sfx }, 'high');
    await expect(approvalService.decideApproval(a.id, 'approved', admin)).rejects.toMatchObject({ status: 403 });
    expect((await prisma.approval.findUnique({ where: { id: a.id } }))!.status).toBe('pending');
    const done = await approvalService.decideApproval(a.id, 'approved', superadmin);
    expect(done.status).toBe('executed');
    expect((done.result as any).moneyMoved).toBe(false);
    const note = await prisma.message.findFirst({ where: { body: { contains: sfx }, channel: 'system' } });
    expect(note).toBeTruthy();
  });

  it('unknown id is 404', async () => {
    await expect(approvalService.decideApproval(randomUUID(), 'approved', superadmin)).rejects.toMatchObject({ status: 404 });
  });

  it('lead.discount_offer sends the approved text after commit and records a Message', async () => {
    vi.mocked(enqueueWhatsApp).mockClear();
    const a = await mkApproval('lead.discount_offer', { leadId: leadOptOut, text: `Offer ${sfx}` });
    const failed = await approvalService.decideApproval(a.id, 'approved', admin);
    expect(failed.status).toBe('failed'); // opted out -> honest failure, nothing sent
    expect(enqueueWhatsApp).not.toHaveBeenCalled();

    const lead = await mkLead(parentA);
    const b = await mkApproval('lead.discount_offer', { leadId: lead.id, text: `Offer ${sfx}` });
    const ok = await approvalService.decideApproval(b.id, 'approved', admin);
    expect(ok.status).toBe('executed');
    expect(enqueueWhatsApp).toHaveBeenCalledWith(expect.objectContaining({ text: `Offer ${sfx}`, targetId: lead.id }));
    expect(await prisma.message.count({ where: { leadId: lead.id, direction: 'outbound' } })).toBe(1);
  });

  it('message.broadcast skips opted-out parents', async () => {
    vi.mocked(enqueueWhatsApp).mockClear();
    const l1 = await mkLead(parentA);
    const a = await mkApproval('message.broadcast', { leadIds: [l1.id, leadOptOut], text: `Hello ${sfx}` }, 'high');
    const done = await approvalService.decideApproval(a.id, 'approved', superadmin);
    expect(done.status).toBe('executed');
    expect((done.result as any).skippedOptedOut).toEqual([leadOptOut]);
    expect(enqueueWhatsApp).toHaveBeenCalledTimes(1);
  });

  it('a failing executor marks the approval failed with the error and rolls back', async () => {
    const a = await mkApproval('lead.mark_lost', { leadId: randomUUID() });
    const done = await approvalService.decideApproval(a.id, 'approved', admin);
    expect(done.status).toBe('failed');
    expect((done.result as any).error).toMatch(/not found/);
  });

  it('student.certificate is log-only and reports unknown students honestly', async () => {
    const bad = await mkApproval('student.certificate', { studentId: randomUUID() });
    expect((await approvalService.decideApproval(bad.id, 'approved', admin)).status).toBe('failed');

    const st = await prisma.student.create({ data: { parentId: parentA, fullName: `Cert ${sfx}` } });
    try {
      const a = await mkApproval('student.certificate', { studentId: st.id });
      const done = await approvalService.decideApproval(a.id, 'approved', admin);
      expect(done.status).toBe('executed');
      expect((done.result as any).loggedOnly).toBe(true);
    } finally {
      await prisma.student.delete({ where: { id: st.id } });
    }
  });
});
