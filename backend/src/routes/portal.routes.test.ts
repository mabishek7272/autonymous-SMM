import request from 'supertest';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import app from '../app';
import { prisma } from '../utils/database';
import { signToken } from '../utils/jwt';

describe('GET /api/v1/portal/*', () => {
  let parentId: string;
  let otherParentId: string;
  let studentId: string;
  let otherStudentId: string;
  let token: string;

  beforeAll(async () => {
    const parent = await prisma.parent.create({ data: { fullName: 'Portal Parent', whatsappNumber: '919990001111' } });
    const otherParent = await prisma.parent.create({ data: { fullName: 'Other Parent', whatsappNumber: '919990002222' } });
    parentId = parent.id;
    otherParentId = otherParent.id;
    const student = await prisma.student.create({ data: { parentId, fullName: 'Portal Kid', status: 'active' } });
    const otherStudent = await prisma.student.create({ data: { parentId: otherParentId, fullName: 'Other Kid', status: 'active' } });
    studentId = student.id;
    otherStudentId = otherStudent.id;
    await prisma.payment.create({ data: { reference: `PORTAL-${studentId}`, amount: 5000, studentId } });
    await prisma.payment.create({ data: { reference: `PORTAL-${otherStudentId}`, amount: 9999, studentId: otherStudentId } });
    token = signToken({ userId: 'u1', email: 'p@example.com', role: 'parent', parentId });
  });

  afterAll(async () => {
    await prisma.payment.deleteMany({ where: { studentId: { in: [studentId, otherStudentId] } } });
    await prisma.student.deleteMany({ where: { id: { in: [studentId, otherStudentId] } } });
    await prisma.parent.deleteMany({ where: { id: { in: [parentId, otherParentId] } } });
  });

  it('returns only the caller\'s own children\'s payments, never another family\'s', async () => {
    const res = await request(app).get('/api/v1/portal/payments').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const refs = res.body.payments.map((p: { reference: string }) => p.reference);
    expect(refs).toContain(`PORTAL-${studentId}`);
    expect(refs).not.toContain(`PORTAL-${otherStudentId}`);
  });

  it('rejects staff roles — this route group is customer-only', async () => {
    const staffToken = signToken({ userId: 'u2', email: 'staff@example.com', role: 'manager' });
    const res = await request(app).get('/api/v1/portal/overview').set('Authorization', `Bearer ${staffToken}`);
    expect(res.status).toBe(403);
  });

  it('rejects unauthenticated requests', async () => {
    const res = await request(app).get('/api/v1/portal/overview');
    expect(res.status).toBe(401);
  });
});
