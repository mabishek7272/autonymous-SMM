import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { UserRole } from '@prisma/client';

vi.mock('../utils/queues', async (orig) => ({
  ...(await orig<typeof import('../utils/queues')>()),
  enqueueWhatsApp: vi.fn(async () => undefined),
}));

import app from '../app';
import { prisma } from '../utils/database';
import { signToken } from '../utils/jwt';
import { approvalService } from '../services/approval.service';

const sfx = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const tok = (role: UserRole) => ({ Authorization: `Bearer ${signToken({ userId: randomUUID(), email: `${role}@x.in`, role })}` });

const parentIds: string[] = [];
const leadIds: string[] = [];
const approvalIds: string[] = [];
let leadId: string;

beforeAll(async () => {
  const p = await prisma.parent.create({ data: { fullName: `RouteTest ${sfx}`, whatsappNumber: `5${sfx}`.slice(0, 20) } });
  parentIds.push(p.id);
  const l = await prisma.lead.create({ data: { parentId: p.id } });
  leadIds.push(l.id);
  leadId = l.id;
});

afterAll(async () => {
  await prisma.aiActivityLog.deleteMany({ where: { OR: [{ targetId: { in: leadIds } }, { agentId: { in: ['RouteTestAgent', `user:${sfx}`] } }, { actionType: `=cmd${sfx}` }] } });
  await prisma.approval.deleteMany({ where: { OR: [{ id: { in: approvalIds } }, { targetId: { in: leadIds } }] } });
  await prisma.lead.deleteMany({ where: { id: { in: leadIds } } });
  await prisma.parent.deleteMany({ where: { id: { in: parentIds } } });
});

describe('approval queue routes', () => {
  it('requires auth and agents:view; teachers are forbidden', async () => {
    expect((await request(app).get('/api/v1/agents/approval-queue')).status).toBe(401);
    expect((await request(app).get('/api/v1/agents/approval-queue').set(tok('teacher'))).status).toBe(403);
  });

  it('lists real pending rows (no invented items) and validates status', async () => {
    const a = await approvalService.requestApproval({ agentId: 'RouteTestAgent', actionType: 'lead.mark_lost', title: `q ${sfx}`, payload: { leadId }, targetId: leadId });
    approvalIds.push(a.id);
    const res = await request(app).get('/api/v1/agents/approval-queue').set(tok('manager'));
    expect(res.status).toBe(200);
    expect(res.body.some((x: any) => x.id === a.id)).toBe(true);
    expect(res.body.some((x: any) => /^appr-/.test(x.id))).toBe(false);
    expect((await request(app).get('/api/v1/agents/approval-queue?status=bogus').set(tok('manager'))).status).toBe(400);
  });

  it('manager cannot decide; admin approves; second decision is 409; bad body is 400', async () => {
    const a = await approvalService.requestApproval({ agentId: 'RouteTestAgent', actionType: 'lead.mark_lost', title: `d ${sfx}`, payload: { leadId }, targetId: leadId });
    approvalIds.push(a.id);
    const url = `/api/v1/agents/approval-queue/${a.id}/decision`;
    expect((await request(app).post(url).set(tok('manager')).send({ decision: 'approved' })).status).toBe(403);
    expect((await request(app).post(url).set(tok('admin')).send({ decision: 'maybe' })).status).toBe(400);
    const ok = await request(app).post(url).set(tok('admin')).send({ decision: 'APPROVED', note: 'fine' });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('executed');
    expect((await prisma.lead.findUnique({ where: { id: leadId } }))!.status).toBe('lost');
    expect((await request(app).post(url).set(tok('superadmin')).send({ decision: 'approved' })).status).toBe(409);
    expect((await request(app).post(`/api/v1/agents/approval-queue/${randomUUID()}/decision`).set(tok('admin')).send({ decision: 'approved' })).status).toBe(404);
  });

  it('high-risk items: admin 403, superadmin 200', async () => {
    const a = await approvalService.requestApproval({ agentId: 'RouteTestAgent', actionType: 'payment.refund', title: `h ${sfx}`, payload: { note: sfx }, risk: 'high' });
    approvalIds.push(a.id);
    const url = `/api/v1/agents/approval-queue/${a.id}/decision`;
    expect((await request(app).post(url).set(tok('admin')).send({ decision: 'approved' })).status).toBe(403);
    expect((await request(app).post(url).set(tok('superadmin')).send({ decision: 'approved' })).status).toBe(200);
    await prisma.message.deleteMany({ where: { body: { contains: sfx } } });
  });
});

describe('lead status guard and listing', () => {
  it('non-admin roles and agents get an approval instead of a direct lost; admin applies directly', async () => {
    const p = await prisma.parent.create({ data: { fullName: `RouteLost ${sfx}`, whatsappNumber: `4${sfx}`.slice(0, 20) } });
    parentIds.push(p.id);
    const l = await prisma.lead.create({ data: { parentId: p.id } });
    leadIds.push(l.id);

    const byManager = await request(app).patch(`/api/v1/leads/${l.id}/status`).set(tok('manager')).send({ status: 'lost' });
    expect(byManager.status).toBe(202);
    expect(byManager.body.pendingApproval).toBe(true);
    expect((await prisma.lead.findUnique({ where: { id: l.id } }))!.status).toBe('enquiry');

    const byAgentAdmin = await request(app).patch(`/api/v1/leads/${l.id}/status`).set(tok('admin')).send({ status: 'lost', agentId: 'AdmissionsAI' });
    expect(byAgentAdmin.status).toBe(202);
    expect(byAgentAdmin.body.approvalId).toBe(byManager.body.approvalId); // de-duplicated

    expect((await request(app).delete(`/api/v1/leads/${l.id}`).set(tok('manager'))).status).toBe(202);

    const direct = await request(app).patch(`/api/v1/leads/${l.id}/status`).set(tok('admin')).send({ status: 'lost' });
    expect(direct.status).toBe(200);
    expect(direct.body.status).toBe('lost');

    expect((await request(app).patch(`/api/v1/leads/${randomUUID()}/status`).set(tok('admin')).send({ status: 'lost' })).status).toBe(404);
  });

  it('paginates with a capped limit, searches by q, and qualify accepts aiScore/notes', async () => {
    const res = await request(app).get(`/api/v1/leads?q=RouteTest ${sfx}&limit=500`).set(tok('manager'));
    expect(res.status).toBe(400);
    const ok = await request(app).get(`/api/v1/leads?q=RouteTest ${sfx}&limit=100&page=1`).set(tok('manager'));
    expect(ok.status).toBe(200);
    expect(ok.body.meta).toMatchObject({ total: 1, page: 1, limit: 100, totalPages: 1 });
    expect(ok.body.data[0].id).toBe(leadId);

    const q = await request(app).post(`/api/v1/leads/${leadId}/qualify`).set(tok('manager')).send({
      gradeInterested: 'Class 9', boardInterested: 'CBSE', subjectsInterested: ['Maths'], aiScore: 72, notes: 'keen',
    });
    expect(q.status).toBe(200);
    expect(q.body).toMatchObject({ aiScore: 72, notes: 'keen' });
    expect((await request(app).post(`/api/v1/leads/${leadId}/qualify`).set(tok('manager')).send({
      gradeInterested: 'Class 9', boardInterested: 'CBSE', subjectsInterested: [], aiScore: 101,
    })).status).toBe(400);
  });
});

describe('activity log CSV export', () => {
  it('quotes cells and neutralises formula injection', async () => {
    await prisma.aiActivityLog.create({
      data: { agentId: 'RouteTestAgent', actionType: `=cmd${sfx}`, targetId: '+1', payload: { a: 'x"y', b: '@z' }, status: 'success' },
    });
    const res = await request(app).get('/api/v1/agents/activity-log/export').set(tok('admin'));
    expect(res.status).toBe(200);
    const line = res.text.split('\n').find((l) => l.includes(`cmd${sfx}`))!;
    expect(line).toContain(`"'=cmd${sfx}"`);
    expect(line).toContain(`"'+1"`);
    expect(line).toContain('""a"":""x\\""y""');
    expect(res.text.split('\n')[0]).toBe('"id","timestamp","agentId","actionType","status","targetId","payload"');
  });
});
