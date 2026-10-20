import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { prisma } from '../utils/database';

vi.mock('../utils/queues', async (orig) => ({
  ...(await orig<typeof import('../utils/queues')>()),
  enqueueWhatsApp: vi.fn(async () => undefined),
}));

import { enqueueWhatsApp } from '../utils/queues';
import app from '../app';

const KEY = `test-agent-key-${randomUUID()}`;
const sfx = Math.floor(Math.random() * 1e8).toString().padStart(8, '0');
const tenDigit = `99${sfx}`; // 10-digit Indian mobile
const phone = `91${tenDigit}`;
const callIds: string[] = [];
const newCallId = () => { const id = `test-${randomUUID()}`.slice(0, 40); callIds.push(id); return id; };
const H = { 'X-Agent-Key': KEY };

let parentId: string;
let leadId: string;
let optedParentId: string;
let optedLeadId: string;
let studentId: string;
const originalKey = process.env.EKALAVYA_AGENT_KEY;

beforeAll(async () => {
  process.env.EKALAVYA_AGENT_KEY = KEY;
  parentId = (await prisma.parent.create({ data: { fullName: `Voice Parent ${sfx}`, whatsappNumber: phone } })).id;
  leadId = (await prisma.lead.create({
    data: { parentId, gradeInterested: 'Class 10', boardInterested: 'CBSE', subjectsInterested: ['Maths'] },
  })).id;
  studentId = (await prisma.student.create({ data: { parentId, fullName: `Voice Kid ${sfx}` } })).id;
  const op = await prisma.parent.create({ data: { fullName: `Voice Opted ${sfx}`, whatsappNumber: `9188${sfx}`.slice(0, 12), optedOut: true } });
  optedParentId = op.id;
  optedLeadId = (await prisma.lead.create({ data: { parentId: op.id } })).id;
});

afterEach(() => { process.env.EKALAVYA_AGENT_KEY = KEY; });

afterAll(async () => {
  process.env.EKALAVYA_AGENT_KEY = originalKey;
  const leads = [leadId, optedLeadId];
  const parents = [parentId, optedParentId];
  await prisma.aiActivityLog.deleteMany({
    where: { OR: [{ targetId: { in: [...leads, ...parents, ...callIds] } }, { payload: { path: ['callId'], string_starts_with: 'test-' } }] },
  });
  await prisma.message.deleteMany({ where: { OR: [{ leadId: { in: leads } }, { parentId: { in: parents } }] } });
  await prisma.callLog.deleteMany({ where: { callId: { in: callIds } } });
  await prisma.appointment.deleteMany({ where: { leadId: { in: leads } } });
  await prisma.student.deleteMany({ where: { id: studentId } });
  await prisma.lead.deleteMany({ where: { id: { in: leads } } });
  await prisma.parent.deleteMany({ where: { id: { in: parents } } });
});

describe('agent key middleware', () => {
  it('returns 503 when EKALAVYA_AGENT_KEY is unset, even with a header', async () => {
    delete process.env.EKALAVYA_AGENT_KEY;
    const res = await request(app).get('/api/v1/agent-api/persona').set(H);
    expect(res.status).toBe(503);
  });

  it('returns 401 without the header, with a wrong key, and when the key is only in the query string', async () => {
    expect((await request(app).get('/api/v1/agent-api/persona')).status).toBe(401);
    expect((await request(app).get('/api/v1/agent-api/persona').set('X-Agent-Key', 'nope')).status).toBe(401);
    expect((await request(app).get(`/api/v1/agent-api/persona?key=${KEY}&token=${KEY}`)).status).toBe(401);
  });

  it('does not accept a Bearer header as the agent key', async () => {
    expect((await request(app).get('/api/v1/agent-api/persona').set('Authorization', `Bearer ${KEY}`)).status).toBe(401);
  });
});

describe('persona and tools', () => {
  it('serves a voice persona with AI + transcription disclosure and no invented fees', async () => {
    const res = await request(app).get('/api/v1/agent-api/persona').set(H);
    expect(res.status).toBe(200);
    expect(res.body.greeting.split('.')[0]).toMatch(/automated/i);
    expect(res.body.greeting).toMatch(/transcribed/i);
    expect(res.body.languages).toEqual(expect.arrayContaining(['en', 'ta']));
    expect(res.body.systemPrompt).toMatch(/never quote fees/i);
    expect(res.body.systemPrompt).not.toMatch(/₹|Rs\.?\s*\d|\bINR\b/);
  });

  it('lists exactly the voice tool subset in OpenAI format', async () => {
    const res = await request(app).get('/api/v1/agent-api/tools').set(H);
    expect(res.status).toBe(200);
    const names = res.body.tools.map((t: any) => t.function.name).sort();
    expect(names).toEqual(['book_demo', 'check_calendar', 'get_lead', 'qualify_lead', 'send_whatsapp_message', 'update_lead_status']);
    expect(res.body.tools[0].type).toBe('function');
    expect(res.body.tools[0].function.parameters.type).toBe('object');
  });
});

describe('POST /tools/:name', () => {
  it('rejects unknown and non-voice tools', async () => {
    for (const name of ['create_lead', 'nope', '__proto__']) {
      const res = await request(app).post(`/api/v1/agent-api/tools/${name}`).set(H).send({ args: {}, callId: 'c1' });
      expect(res.status).toBe(404);
      expect(res.body.ok).toBe(false);
    }
  });

  it('rejects a malformed body and missing auth', async () => {
    const res = await request(app).post('/api/v1/agent-api/tools/check_calendar').set(H).send({ args: 'x' });
    expect(res.status).toBe(400);
    expect((await request(app).post('/api/v1/agent-api/tools/check_calendar').send({ args: {}, callId: 'c1' })).status).toBe(401);
  });

  it('runs check_calendar and writes an audit row carrying the callId', async () => {
    const callId = newCallId();
    const res = await request(app).post('/api/v1/agent-api/tools/check_calendar').set(H).send({ args: { date: '2099-01-05' }, callId, leadId });
    expect(res.body.ok).toBe(true);
    expect(res.body.result.availableSlots[0].iso).toBe('2099-01-05T04:30:00.000Z');
    const rows = await prisma.aiActivityLog.findMany({ where: { agentId: 'AdmissionsAI', actionType: 'voice_tool_call', targetId: leadId } });
    expect(rows.some((r) => (r.payload as any).callId === callId)).toBe(true);
  });

  it('applies Zod validation (ok:false) through the shared executor', async () => {
    const res = await request(app).post('/api/v1/agent-api/tools/check_calendar').set(H).send({ args: { date: 'tomorrow' }, callId: newCallId() });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/Invalid arguments/);
    const bad = await request(app).post('/api/v1/agent-api/tools/qualify_lead').set(H).send({ args: { leadId: 'x' }, callId: newCallId(), leadId });
    expect(bad.body.ok).toBe(false);
  });

  it('book_demo runs as DemoCoordinatorAI and updates the lead', async () => {
    const when = new Date(Date.now() + 5 * 86400000);
    when.setUTCHours(4, 30, 0, 0);
    const res = await request(app).post('/api/v1/agent-api/tools/book_demo').set(H)
      .send({ args: { scheduledAt: when.toISOString() }, callId: newCallId(), leadId });
    expect(res.body.ok).toBe(true);
    expect((await prisma.lead.findUnique({ where: { id: leadId } }))?.status).toBe('demo_scheduled');
    const audit = await prisma.aiActivityLog.findFirst({ where: { targetId: leadId, actionType: 'tool_book_demo' } });
    expect(audit?.agentId).toBe('DemoCoordinatorAI');
  });

  it('keeps a lead-bound conversation inside its own lead', async () => {
    const res = await request(app).post('/api/v1/agent-api/tools/get_lead').set(H)
      .send({ args: { leadId: optedLeadId }, callId: newCallId(), leadId });
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/Out of scope/);
  });

  it('get_lead never returns the parent contact details', async () => {
    const res = await request(app).post('/api/v1/agent-api/tools/get_lead').set(H).send({ args: {}, callId: newCallId(), leadId });
    expect(res.body.ok).toBe(true);
    expect(res.body.result.parent.whatsappNumber).toBeUndefined();
    expect(res.body.result.parent.fullName).toBe(`Voice Parent ${sfx}`);
  });

  it('still enforces the 3 messages / 24h guardrail for send_whatsapp_message', async () => {
    vi.mocked(enqueueWhatsApp).mockClear();
    for (let i = 0; i < 3; i++) {
      const ok = await request(app).post('/api/v1/agent-api/tools/send_whatsapp_message').set(H)
        .send({ args: { text: `hello ${i}` }, callId: newCallId(), leadId });
      expect(ok.body.ok).toBe(true);
    }
    const fourth = await request(app).post('/api/v1/agent-api/tools/send_whatsapp_message').set(H)
      .send({ args: { text: 'one more' }, callId: newCallId(), leadId });
    expect(fourth.body.ok).toBe(false);
    expect(fourth.body.error).toMatch(/max 3/);
    expect(enqueueWhatsApp).toHaveBeenCalledTimes(3);
  });

  it('refuses to message an opted-out parent', async () => {
    const res = await request(app).post('/api/v1/agent-api/tools/send_whatsapp_message').set(H)
      .send({ args: { text: 'hi' }, callId: newCallId(), leadId: optedLeadId });
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/opted out/);
  });
});

describe('POST /calls/identify', () => {
  it.each([
    ['plain 10 digit', tenDigit],
    ['with country code', phone],
    ['plus and spaces', `+91 ${tenDigit.slice(0, 5)} ${tenDigit.slice(5)}`],
    ['trunk zero', `0${tenDigit}`],
    ['whatsapp jid', `${phone}@s.whatsapp.net`],
  ])('finds the parent by %s', async (_n, raw) => {
    const res = await request(app).post('/api/v1/agent-api/calls/identify').set(H).send({ phone: raw });
    expect(res.status).toBe(200);
    expect(res.body.parent).toEqual({ id: parentId, fullName: `Voice Parent ${sfx}` });
    expect(res.body.lead.id).toBe(leadId);
    expect(res.body.lead.gradeInterested).toBe('Class 10');
    expect(res.body.students).toEqual([{ id: studentId, fullName: `Voice Kid ${sfx}` }]);
    expect(JSON.stringify(res.body)).not.toContain(phone);
  });

  it('returns nulls for an unknown number and 400 for garbage', async () => {
    const unknown = await request(app).post('/api/v1/agent-api/calls/identify').set(H).send({ phone: '9000000001' });
    expect(unknown.status).toBe(200);
    expect(unknown.body).toEqual({ parent: null, lead: null, openAppointment: null, students: [] });
    expect((await request(app).post('/api/v1/agent-api/calls/identify').set(H).send({ phone: 'abc' })).status).toBe(400);
    expect((await request(app).post('/api/v1/agent-api/calls/identify').set(H).send({})).status).toBe(400);
  });
});

describe('POST /call-log', () => {
  const body = (callId: string, extra: Record<string, unknown> = {}) => ({
    callId,
    startedAt: '2030-01-10T08:00:00.000Z',
    endedAt: '2030-01-10T08:02:00.000Z',
    durationSec: 120,
    transcript: [
      { role: 'agent', text: 'Hello', ts: '2030-01-10T08:00:01.000Z' },
      { role: 'caller', text: 'Hi, I want a demo', ts: '2030-01-10T08:00:05.000Z' },
    ],
    ...extra,
  });

  it('requires auth and validates the body', async () => {
    expect((await request(app).post('/api/v1/agent-api/call-log').send(body('x'))).status).toBe(401);
    expect((await request(app).post('/api/v1/agent-api/call-log').set(H).send({ callId: 'x' })).status).toBe(400);
    const badOutcome = await request(app).post('/api/v1/agent-api/call-log').set(H).send(body(newCallId(), { outcome: 'sold' }));
    expect(badOutcome.status).toBe(400);
  });

  it('resolves parent and lead by phone, writes Message + activity log, and is idempotent by callId', async () => {
    vi.mocked(enqueueWhatsApp).mockClear();
    const callId = newCallId();
    const first = await request(app).post('/api/v1/agent-api/call-log').set(H)
      .send(body(callId, { phone: `+91 ${tenDigit}`, outcome: 'demo_booked', summary: 'Parent wants a demo' }));
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ parentId, leadId, created: true, optedOut: false, messageStored: true });

    const again = await request(app).post('/api/v1/agent-api/call-log').set(H)
      .send(body(callId, { phone, outcome: 'info_only', summary: 'Updated summary' }));
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);

    const rows = await prisma.callLog.findMany({ where: { callId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ parentId, leadId, phone, outcome: 'info_only', durationSec: 120, summary: 'Updated summary' });
    expect(Array.isArray(rows[0].transcript)).toBe(true);
    expect(rows[0].createdAt.toISOString()).toBe('2030-01-10T08:00:00.000Z');

    const msgs = await prisma.message.findMany({ where: { externalId: `call:${callId}` } });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ channel: 'call', direction: 'inbound', body: 'Updated summary', leadId });

    const logs = await prisma.aiActivityLog.findMany({ where: { actionType: 'voice_call_completed', targetId: leadId } });
    const mine = logs.filter((l) => (l.payload as any).callId === callId);
    expect(mine).toHaveLength(1);
    expect(mine[0].agentId).toBe('AdmissionsAI');
    expect(enqueueWhatsApp).not.toHaveBeenCalled(); // call-log never sends anything
  });

  it('a repeat post with fewer fields does not erase links resolved earlier', async () => {
    const callId = newCallId();
    await request(app).post('/api/v1/agent-api/call-log').set(H).send(body(callId, { phone, outcome: 'demo_booked' }));
    const again = await request(app).post('/api/v1/agent-api/call-log').set(H).send(body(callId));
    expect(again.status).toBe(200);
    const row = await prisma.callLog.findUnique({ where: { callId } });
    expect(row).toMatchObject({ parentId, leadId, phone, outcome: 'demo_booked' });
  });

  it('falls back to the transcript when no summary is given', async () => {
    const callId = newCallId();
    await request(app).post('/api/v1/agent-api/call-log').set(H).send(body(callId, { leadId }));
    const msg = await prisma.message.findUnique({ where: { externalId: `call:${callId}` } });
    expect(msg?.body).toContain('caller: Hi, I want a demo');
  });

  it('logs calls from opted-out parents but flags them', async () => {
    const callId = newCallId();
    const res = await request(app).post('/api/v1/agent-api/call-log').set(H).send(body(callId, { leadId: optedLeadId }));
    expect(res.status).toBe(201);
    expect(res.body.optedOut).toBe(true);
    const msg = await prisma.message.findUnique({ where: { externalId: `call:${callId}` } });
    expect(msg?.status).toBe('logged:opted_out');
    const log = await prisma.aiActivityLog.findFirst({ where: { actionType: 'voice_call_completed', targetId: optedLeadId } });
    expect((log?.payload as any).optedOut).toBe(true);
  });

  it('stores an anonymous call without inventing a parent', async () => {
    const res = await request(app).post('/api/v1/agent-api/call-log').set(H).send(body(newCallId(), { phone: '9000000002' }));
    expect(res.status).toBe(201);
    expect(res.body.parentId).toBeNull();
    expect(res.body.messageStored).toBe(false);
  });

  it('404s for an unknown leadId', async () => {
    const res = await request(app).post('/api/v1/agent-api/call-log').set(H).send(body(newCallId(), { leadId: randomUUID() }));
    expect(res.status).toBe(404);
  });
});
