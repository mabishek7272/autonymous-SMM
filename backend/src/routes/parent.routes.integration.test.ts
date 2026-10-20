import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { UserRole } from '@prisma/client';
import app from '../app';
import { prisma } from '../utils/database';
import { signToken } from '../utils/jwt';
import { normaliseWhatsappNumber } from './parent.routes';

const auth = () => ({ Authorization: `Bearer ${signToken({ userId: randomUUID(), email: 'm@x.in', role: UserRole.manager })}` });
// unique 10-digit Indian mobile
const mobile = `9${String(Date.now()).slice(-9)}`;

afterAll(async () => {
  await prisma.parent.deleteMany({ where: { whatsappNumber: `91${mobile}` } });
});

describe('parent routes (db)', () => {
  it('normalises phone formats', () => {
    expect(normaliseWhatsappNumber('+91 98765-43210')).toBe('919876543210');
    expect(normaliseWhatsappNumber('09876543210')).toBe('919876543210');
    expect(normaliseWhatsappNumber('9876543210')).toBe('919876543210');
    expect(normaliseWhatsappNumber('00447911123456')).toBe('447911123456');
  });

  it('creates with a normalised number and returns 409 on a duplicate in any format', async () => {
    const first = await request(app).post('/api/v1/parents').set(auth()).send({ fullName: '  Test Parent ', whatsappNumber: `+91 ${mobile}`, email: 'A@X.IN' });
    expect(first.status).toBe(201);
    expect(first.body.whatsappNumber).toBe(`91${mobile}`);
    expect(first.body.fullName).toBe('Test Parent');
    expect(first.body.email).toBe('a@x.in');

    const dup = await request(app).post('/api/v1/parents').set(auth()).send({ fullName: 'Other', whatsappNumber: mobile });
    expect(dup.status).toBe(409);
  });

  it('rejects invalid numbers and unknown ids', async () => {
    expect((await request(app).post('/api/v1/parents').set(auth()).send({ fullName: 'Bad', whatsappNumber: '12ab' })).status).toBe(400);
    expect((await request(app).get('/api/v1/parents/not-a-uuid').set(auth())).status).toBe(400);
    expect((await request(app).get(`/api/v1/parents/${randomUUID()}`).set(auth())).status).toBe(404);
  });
});
