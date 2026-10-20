import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { UserRole, LeadStatus } from '@prisma/client';

const enqueueWhatsApp = vi.fn();
vi.mock('../utils/queues', () => ({ enqueueWhatsApp: (...a: unknown[]) => enqueueWhatsApp(...a) }));

import app from '../app';
import { prisma } from '../utils/database';
import { signToken } from '../utils/jwt';

const sfx = randomUUID().slice(0, 8);
const userId = randomUUID();
const auth = () => ({ Authorization: `Bearer ${signToken({ userId, email: 'm@x.in', role: UserRole.manager })}` });

let parentId: string, optedOutParentId: string, courseId: string, batchId: string, recorderId: string;
const leadIds: string[] = [];

async function newLead(status: LeadStatus, pid = parentId) {
  const l = await prisma.lead.create({ data: { parentId: pid, status } });
  leadIds.push(l.id);
  return l.id;
}
const ref = (n: string) => `T${sfx}-${n}`;

beforeAll(async () => {
  recorderId = (await prisma.user.create({ data: { fullName: `Rec ${sfx}`, email: `rec${sfx}@x.in`, passwordHash: 'x', role: 'manager' } })).id;
  parentId = (await prisma.parent.create({ data: { fullName: `Onb Parent ${sfx}`, whatsappNumber: `7${Date.now()}`.slice(0, 15) } })).id;
  optedOutParentId = (await prisma.parent.create({ data: { fullName: `Onb OptOut ${sfx}`, whatsappNumber: `6${Date.now()}`.slice(0, 15), optedOut: true } })).id;
  courseId = (await prisma.course.create({ data: { courseName: `Onb Course ${sfx}` } })).id;
  batchId = (await prisma.batch.create({ data: { courseId, batchName: `Onb Batch ${sfx}` } })).id;
});

beforeEach(() => enqueueWhatsApp.mockReset());

afterAll(async () => {
  const students = await prisma.student.findMany({ where: { parentId: { in: [parentId, optedOutParentId] } }, select: { id: true } });
  const sids = students.map((s) => s.id);
  await prisma.aiActivityLog.deleteMany({ where: { targetId: { in: sids }, actionType: 'lead_onboarded_to_student' } });
  await prisma.payment.deleteMany({ where: { reference: { startsWith: `T${sfx}` } } });
  await prisma.enrollment.deleteMany({ where: { studentId: { in: sids } } });
  await prisma.student.deleteMany({ where: { id: { in: sids } } });
  await prisma.lead.deleteMany({ where: { id: { in: leadIds } } });
  await prisma.batch.delete({ where: { id: batchId } });
  await prisma.course.delete({ where: { id: courseId } });
  await prisma.parent.deleteMany({ where: { id: { in: [parentId, optedOutParentId] } } });
  await prisma.user.delete({ where: { id: recorderId } });
});

const body = (leadId: string, reference: string, extra: object = {}) =>
  ({ leadId, studentName: `Kid ${sfx}`, paymentReference: reference, amountPaid: 12500.5, paymentMode: 'UPI', ...extra });

describe('POST /students/onboard-lead', () => {
  it('404 for unknown lead, 409 for non-admissible statuses', async () => {
    expect((await request(app).post('/api/v1/students/onboard-lead').set(auth()).send(body(randomUUID(), ref('a')))).status).toBe(404);
    for (const st of ['enquiry', 'contacted', 'lost'] as LeadStatus[]) {
      const res = await request(app).post('/api/v1/students/onboard-lead').set(auth()).send(body(await newLead(st), ref(`s-${st}`)));
      expect(res.status).toBe(409);
    }
    expect(await prisma.payment.count({ where: { reference: { startsWith: `T${sfx}` } } })).toBe(0);
    expect(enqueueWhatsApp).not.toHaveBeenCalled();
  });

  it('creates payment, student, enrollment, converts lead, audits, and queues the welcome message', async () => {
    const leadId = await newLead('qualified');
    const res = await request(app).post('/api/v1/students/onboard-lead').set(auth()).send(body(leadId, ref('ok'), { batchId }));
    expect(res.status).toBe(201);
    expect(res.body.welcomeMessage).toBe('queued');
    expect(res.body.enrollment.batchId).toBe(batchId);

    const payment = await prisma.payment.findUnique({ where: { reference: ref('ok') } });
    expect(payment).toMatchObject({ leadId, studentId: res.body.student.id, method: 'UPI' });
    expect(Number(payment!.amount)).toBe(12500.5);
    expect((await prisma.lead.findUnique({ where: { id: leadId } }))!.status).toBe('converted');
    const log = await prisma.aiActivityLog.findFirst({ where: { targetId: res.body.student.id, actionType: 'lead_onboarded_to_student' } });
    expect(log).not.toBeNull();
    expect(enqueueWhatsApp).toHaveBeenCalledTimes(1);
  });

  it('rejects a duplicate paymentReference with 409 and creates nothing', async () => {
    const before = await prisma.student.count({ where: { parentId } });
    const res = await request(app).post('/api/v1/students/onboard-lead').set(auth()).send(body(await newLead('demo_scheduled'), ref('ok')));
    expect(res.status).toBe(409);
    expect(await prisma.student.count({ where: { parentId } })).toBe(before);
  });

  it('rolls everything back when the batch does not exist', async () => {
    const leadId = await newLead('follow_up');
    const before = await prisma.student.count({ where: { parentId } });
    const res = await request(app).post('/api/v1/students/onboard-lead').set(auth()).send(body(leadId, ref('nb'), { batchId: randomUUID() }));
    expect(res.status).toBe(404);
    expect(await prisma.student.count({ where: { parentId } })).toBe(before);
    expect((await prisma.lead.findUnique({ where: { id: leadId } }))!.status).toBe('follow_up');
  });

  it('commits the admission even when queueing the welcome message fails, and says so', async () => {
    enqueueWhatsApp.mockRejectedValueOnce(new Error('redis down'));
    const res = await request(app).post('/api/v1/students/onboard-lead').set(auth()).send(body(await newLead('qualified'), ref('qf')));
    expect(res.status).toBe(201);
    expect(res.body.welcomeMessage).toBe('failed');
    expect(await prisma.payment.findUnique({ where: { reference: ref('qf') } })).not.toBeNull();
  });

  it('does not message opted-out parents', async () => {
    const res = await request(app).post('/api/v1/students/onboard-lead').set(auth()).send(body(await newLead('qualified', optedOutParentId), ref('oo')));
    expect(res.status).toBe(201);
    expect(res.body.welcomeMessage).toBe('skipped_opted_out');
    expect(enqueueWhatsApp).not.toHaveBeenCalled();
  });

  it('validates the body', async () => {
    const res = await request(app).post('/api/v1/students/onboard-lead').set(auth()).send({ leadId: 'nope' });
    expect(res.status).toBe(400);
  });

  it('creates a parent-role portal account when the parent has an email on file', async () => {
    const onboardParent = await prisma.parent.create({
      data: { fullName: `Portal Onb Parent ${sfx}`, whatsappNumber: `8${Date.now()}`.slice(0, 15), email: `portalonb-${sfx}@x.in` },
    });
    try {
      const leadId = await newLead('qualified', onboardParent.id);
      const res = await request(app).post('/api/v1/students/onboard-lead').set(auth()).send(body(leadId, ref('portal-onb')));
      expect(res.status).toBe(201);

      const portalUser = await prisma.user.findUnique({ where: { email: `portalonb-${sfx}@x.in` } });
      expect(portalUser?.role).toBe('parent');
      expect(portalUser?.parentId).toBe(onboardParent.id);
      expect(res.body.student).toBeDefined();
      // Login for this role is OTP-only — there is no password to leak, and none should appear anywhere in the response.
      expect(JSON.stringify(res.body).toLowerCase()).not.toContain('password');

      await prisma.user.delete({ where: { id: portalUser!.id } });
      await prisma.payment.deleteMany({ where: { studentId: res.body.student.id } });
      await prisma.student.delete({ where: { id: res.body.student.id } });
      await prisma.lead.delete({ where: { id: leadId } });
      leadIds.splice(leadIds.indexOf(leadId), 1);
    } finally {
      await prisma.parent.delete({ where: { id: onboardParent.id } });
    }
  });
});
