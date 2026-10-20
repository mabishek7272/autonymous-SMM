import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { UserRole } from '@prisma/client';
import app from '../app';
import { prisma } from '../utils/database';
import { signToken } from '../utils/jwt';

const tok = (role: UserRole) => ({ Authorization: `Bearer ${signToken({ userId: randomUUID(), email: `${role}@x.in`, role })}` });
const sfx = Math.floor(Math.random() * 1e9).toString().padStart(9, '0');
let parentId: string;
let leadId: string;
let callRowId: string;
const callIds = [`test-call-${sfx}-a`, `test-call-${sfx}-b`];

beforeAll(async () => {
  parentId = (await prisma.parent.create({ data: { fullName: `Calls Parent ${sfx}`, whatsappNumber: `917${sfx}` } })).id;
  leadId = (await prisma.lead.create({ data: { parentId } })).id;
  const a = await prisma.callLog.create({
    data: { callId: callIds[0], parentId, leadId, transcript: [{ role: 'agent', text: 'Hi', ts: 't' }], outcome: 'info_only', durationSec: 30 },
  });
  callRowId = a.id;
  await prisma.callLog.create({ data: { callId: callIds[1], parentId, transcript: [] } });
});

afterAll(async () => {
  await prisma.callLog.deleteMany({ where: { callId: { in: callIds } } });
  await prisma.lead.deleteMany({ where: { id: leadId } });
  await prisma.parent.deleteMany({ where: { id: parentId } });
});

describe('staff call routes', () => {
  it('requires auth and denies teachers', async () => {
    expect((await request(app).get('/api/v1/calls')).status).toBe(401);
    expect((await request(app).get('/api/v1/calls').set(tok(UserRole.teacher))).status).toBe(403);
    expect((await request(app).get(`/api/v1/calls/${callRowId}`).set(tok(UserRole.teacher))).status).toBe(403);
  });

  it('lists calls filtered by leadId and parentId with pagination and transcript', async () => {
    const byLead = await request(app).get(`/api/v1/calls?leadId=${leadId}`).set(tok(UserRole.manager));
    expect(byLead.status).toBe(200);
    expect(byLead.body.total).toBe(1);
    expect(byLead.body.data[0].transcript[0].text).toBe('Hi');
    const byParent = await request(app).get(`/api/v1/calls?parentId=${parentId}&limit=1&page=2`).set(tok(UserRole.admin));
    expect(byParent.body).toMatchObject({ total: 2, page: 2, limit: 1, totalPages: 2 });
    expect(byParent.body.data).toHaveLength(1);
  });

  it('rejects bad query values', async () => {
    expect((await request(app).get('/api/v1/calls?leadId=nope').set(tok(UserRole.manager))).status).toBe(400);
    expect((await request(app).get('/api/v1/calls?limit=1000').set(tok(UserRole.manager))).status).toBe(400);
  });

  it('gets one call, 404 for unknown, 400 for malformed id', async () => {
    const ok = await request(app).get(`/api/v1/calls/${callRowId}`).set(tok(UserRole.manager));
    expect(ok.status).toBe(200);
    expect(ok.body.callId).toBe(callIds[0]);
    expect((await request(app).get(`/api/v1/calls/${randomUUID()}`).set(tok(UserRole.manager))).status).toBe(404);
    expect((await request(app).get('/api/v1/calls/xyz').set(tok(UserRole.manager))).status).toBe(400);
  });
});

describe('GET /dev/voice/status', () => {
  const original = process.env.CALL_AGENT_URL;
  afterAll(() => { process.env.CALL_AGENT_URL = original; });

  it('is restricted to dev:console', async () => {
    expect((await request(app).get('/api/v1/dev/voice/status').set(tok(UserRole.teacher))).status).toBe(403);
    expect((await request(app).get('/api/v1/dev/voice/status').set(tok(UserRole.admin))).status).toBe(403);
  });

  it('reports unreachable honestly when nothing listens on the port', async () => {
    process.env.CALL_AGENT_URL = 'http://127.0.0.1:1';
    const res = await request(app).get('/api/v1/dev/voice/status').set(tok(UserRole.superadmin));
    expect(res.status).toBe(200);
    expect(res.body.reachable).toBe(false);
    expect(res.body.status).toBe('unreachable');
  });

  it('merges the call agent health when reachable', async () => {
    const http = await import('http');
    const server = http.createServer((_q, r) => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify({ status: 'ok', stt: true, llm: false, tts: false, version: '9' })); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      process.env.CALL_AGENT_URL = `http://127.0.0.1:${(server.address() as any).port}`;
      const res = await request(app).get('/api/v1/dev/voice/status').set(tok(UserRole.superadmin));
      expect(res.body).toMatchObject({ reachable: true, status: 'ok', stt: true, llm: false, tts: false, version: '9' });
    } finally {
      server.close();
    }
  });
});
