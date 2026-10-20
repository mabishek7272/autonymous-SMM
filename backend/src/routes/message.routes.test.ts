import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { UserRole } from '@prisma/client';
import { prisma } from '../utils/database';
import { signToken } from '../utils/jwt';

vi.mock('../utils/queues', () => ({ enqueueWhatsApp: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../services/messaging.adapter', () => ({
  messagingAdapter: { getConnectionStatus: vi.fn().mockResolvedValue({ state: 'connected', connected: true, loggedIn: true, instance: 'i' }) },
}));

import { enqueueWhatsApp } from '../utils/queues';
import messageRoutes from './message.routes';

const app = express();
app.use(express.json());
app.use('/api/v1/messages', messageRoutes);

const sfx = Date.now().toString().slice(-7);
const tok = (role: UserRole) => `Bearer ${signToken({ userId: '00000000-0000-4000-8000-000000000001', email: 't@t.in', role })}`;
let parentId: string, leadId: string, optedParentId: string, optedLeadId: string;

beforeAll(async () => {
  parentId = (await prisma.parent.create({ data: { fullName: 'MR Test', whatsappNumber: `9195${sfx}1` } })).id;
  leadId = (await prisma.lead.create({ data: { parentId, status: 'enquiry' } })).id;
  optedParentId = (await prisma.parent.create({ data: { fullName: 'MR Opt', whatsappNumber: `9195${sfx}2`, optedOut: true, optedOutAt: new Date() } })).id;
  optedLeadId = (await prisma.lead.create({ data: { parentId: optedParentId, status: 'enquiry' } })).id;
  for (let i = 0; i < 3; i++) {
    await prisma.message.create({ data: { parentId, leadId, direction: i % 2 ? 'outbound' : 'inbound', body: `m${i}`, createdAt: new Date(Date.now() - (3 - i) * 1000) } });
  }
});
afterAll(async () => {
  await prisma.message.deleteMany({ where: { parentId: { in: [parentId, optedParentId] } } });
  await prisma.lead.deleteMany({ where: { id: { in: [leadId, optedLeadId] } } });
  await prisma.parent.deleteMany({ where: { id: { in: [parentId, optedParentId] } } });
  await prisma.$disconnect();
});
beforeEach(() => { vi.mocked(enqueueWhatsApp).mockClear(); });

describe('message routes', () => {
  it('requires auth and permissions', async () => {
    expect((await request(app).get('/api/v1/messages').query({ leadId })).status).toBe(401);
    expect((await request(app).get('/api/v1/messages').query({ leadId }).set('Authorization', tok('teacher'))).status).toBe(403);
    expect((await request(app).post(`/api/v1/messages/lead/${leadId}`).set('Authorization', tok('teacher')).send({ text: 'x' })).status).toBe(403);
    expect((await request(app).get('/api/v1/messages/status').set('Authorization', tok('teacher'))).status).toBe(403);
  });

  it('lists a conversation, paginated, oldest first within the page', async () => {
    const res = await request(app).get('/api/v1/messages').query({ leadId, pageSize: 2 }).set('Authorization', tok('manager'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 3, totalPages: 2, page: 1, pageSize: 2 });
    expect(res.body.data.map((m: any) => m.body)).toEqual(['m1', 'm2']);
  });

  it('validates the query', async () => {
    const auth = tok('admin');
    expect((await request(app).get('/api/v1/messages').set('Authorization', auth)).status).toBe(400);
    expect((await request(app).get('/api/v1/messages').query({ leadId: 'nope' }).set('Authorization', auth)).status).toBe(400);
  });

  it('queues a manual message with full context', async () => {
    const res = await request(app).post(`/api/v1/messages/lead/${leadId}`).set('Authorization', tok('manager')).send({ text: '  Hello!  ' });
    expect(res.status).toBe(202);
    expect(enqueueWhatsApp).toHaveBeenCalledWith(expect.objectContaining({
      to: `9195${sfx}1`, text: 'Hello!', parentId, leadId, messageKind: 'manual',
    }));
  });

  it('rejects empty text, unknown leads and opted-out parents without queueing', async () => {
    const auth = tok('manager');
    expect((await request(app).post(`/api/v1/messages/lead/${leadId}`).set('Authorization', auth).send({ text: ' ' })).status).toBe(400);
    expect((await request(app).post('/api/v1/messages/lead/00000000-0000-4000-8000-0000000000ff').set('Authorization', auth).send({ text: 'x' })).status).toBe(404);
    expect((await request(app).post(`/api/v1/messages/lead/${optedLeadId}`).set('Authorization', auth).send({ text: 'x' })).status).toBe(409);
    expect(enqueueWhatsApp).not.toHaveBeenCalled();
  });

  it('GET /status needs dashboard:view and reports the gateway state', async () => {
    const res = await request(app).get('/api/v1/messages/status').set('Authorization', tok('manager'));
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('connected');
  });
});
