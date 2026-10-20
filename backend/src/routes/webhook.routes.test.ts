import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import crypto from 'crypto';
import request from 'supertest';
import { prisma } from '../utils/database';

vi.mock('../utils/queues', () => ({
  enqueueWhatsApp: vi.fn().mockResolvedValue(undefined),
  OPT_OUT_CONFIRMATION_KIND: 'opt_out_confirmation',
}));
vi.mock('../services/hermes.service', () => ({
  hermesService: { handleInboundMessage: vi.fn().mockResolvedValue('ok') },
}));

import { enqueueWhatsApp } from '../utils/queues';
import { hermesService } from '../services/hermes.service';
import webhookRouter, { metaLeadsRouter, matchOptKeyword, parseGatewayMessage } from './webhook.routes';

const app = express();
app.use('/webhooks/meta-leads', metaLeadsRouter);
app.use(express.json());
app.use('/webhooks', webhookRouter);

const sfx = Date.now().toString().slice(-7);
const mk = (n: number) => `9196${sfx}${n}`.slice(0, 12);
const phones = [mk(1), mk(2), mk(3), mk(4), mk(5), mk(6)];
const KEY = 'test-instance-token';
const SECRET = 'meta-app-secret';

const evt = (o: { id: string; chat: string; text?: string; fromMe?: boolean; group?: boolean; event?: string; token?: string }) => ({
  event: o.event ?? 'Message',
  instanceToken: o.token ?? KEY,
  data: {
    Info: { ID: o.id, Chat: o.chat, IsFromMe: !!o.fromMe, IsGroup: !!o.group, PushName: 'Test Parent' },
    Message: { conversation: o.text ?? 'hello' },
  },
});
const jid = (p: string) => `${p}@s.whatsapp.net`;
const post = (body: unknown) => request(app).post('/webhooks/evolution-go').send(body as object);
const settle = () => new Promise((r) => setTimeout(r, 150)); // processing runs after the 200

async function cleanup() {
  const parents = await prisma.parent.findMany({ where: { whatsappNumber: { in: phones } }, select: { id: true } });
  const ids = parents.map((p) => p.id);
  await prisma.message.deleteMany({ where: { parentId: { in: ids } } });
  await prisma.lead.deleteMany({ where: { parentId: { in: ids } } });
  await prisma.parent.deleteMany({ where: { id: { in: ids } } });
}

beforeAll(() => { process.env.EVOLUTION_GO_API_KEY = KEY; process.env.META_APP_SECRET = SECRET; process.env.META_VERIFY_TOKEN = 'vt'; });
afterAll(async () => { await cleanup(); await prisma.$disconnect(); });
beforeEach(() => { vi.clearAllMocks(); });

describe('helpers', () => {
  it('matches whole-message opt keywords only', () => {
    expect(matchOptKeyword(' STOP. ')).toBe('opt_out');
    expect(matchOptKeyword('Unsubscribe')).toBe('opt_out');
    expect(matchOptKeyword('நிறுத்து')).toBe('opt_out');
    expect(matchOptKeyword('बंद करो')).toBe('opt_out');
    expect(matchOptKeyword('start')).toBe('opt_in');
    expect(matchOptKeyword('please do not stop the classes')).toBeNull();
  });
  it('parses gateway message data', () => {
    expect(parseGatewayMessage({})).toBeNull();
    expect(parseGatewayMessage(evt({ id: 'a', chat: 'x@g.us' }).data)?.isGroup).toBe(true);
  });
});

describe('POST /webhooks/evolution-go', () => {
  it('503 when the key is not configured, 401 on a wrong key, query string never accepted', async () => {
    delete process.env.EVOLUTION_GO_API_KEY;
    expect((await post(evt({ id: 'x', chat: jid(phones[0]) }))).status).toBe(503);
    process.env.EVOLUTION_GO_API_KEY = KEY;
    expect((await post(evt({ id: 'x', chat: jid(phones[0]), token: 'nope' }))).status).toBe(401);
    expect((await request(app).post(`/webhooks/evolution-go?apikey=${KEY}`).send({ event: 'Message' })).status).toBe(401);
    expect((await request(app).post('/webhooks/evolution-go').set('apikey', KEY).send({ event: 'Other' })).status).toBe(200);
  });

  it('creates parent + lead (source null), stores the inbound Message once, calls Hermes once', async () => {
    const body = evt({ id: `in-${sfx}-1`, chat: jid(phones[0]), text: 'Need maths tuition' });
    expect((await post(body)).status).toBe(200);
    await settle();
    expect((await post(body)).status).toBe(200); // gateway retry
    await settle();

    const parent = await prisma.parent.findUnique({ where: { whatsappNumber: phones[0] } });
    expect(parent?.fullName).toBe('Test Parent');
    const lead = await prisma.lead.findFirst({ where: { parentId: parent!.id } });
    expect(lead).toMatchObject({ source: null, status: 'enquiry' });
    expect(await prisma.message.count({ where: { externalId: `in-${sfx}-1` } })).toBe(1);
    expect(hermesService.handleInboundMessage).toHaveBeenCalledTimes(1);
  });

  it('ignores groups and does not create leads for own messages to unknown contacts', async () => {
    await post(evt({ id: `g-${sfx}`, chat: '1203630@g.us', group: true }));
    await post(evt({ id: `m-${sfx}`, chat: jid(phones[1]), fromMe: true }));
    await settle();
    expect(await prisma.message.count({ where: { externalId: { in: [`g-${sfx}`, `m-${sfx}`] } } })).toBe(0);
    expect(await prisma.parent.count({ where: { whatsappNumber: phones[1] } })).toBe(0);
    expect(hermesService.handleInboundMessage).not.toHaveBeenCalled();
  });

  it('stores own outbound messages for known contacts, deduped', async () => {
    await post(evt({ id: `seed-${sfx}`, chat: jid(phones[2]) })); await settle();
    const body = evt({ id: `out-${sfx}`, chat: jid(phones[2]), fromMe: true, text: 'reply from phone', event: 'SendMessage' });
    await post(body); await settle(); await post(body); await settle();
    const rows = await prisma.message.findMany({ where: { externalId: `out-${sfx}` } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ direction: 'outbound', agentId: null });
  });

  it('STOP opts out once with a single confirmation; START opts back in; opted-out messages skip Hermes', async () => {
    const chat = jid(phones[3]);
    await post(evt({ id: `s1-${sfx}`, chat, text: 'hi' })); await settle();
    vi.clearAllMocks();

    await post(evt({ id: `s2-${sfx}`, chat, text: 'STOP' })); await settle();
    let parent = await prisma.parent.findUnique({ where: { whatsappNumber: phones[3] } });
    expect(parent?.optedOut).toBe(true);
    expect(parent?.optedOutAt).toBeInstanceOf(Date);
    expect(enqueueWhatsApp).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enqueueWhatsApp).mock.calls[0][0]).toMatchObject({ to: phones[3], messageKind: 'opt_out_confirmation' });

    await post(evt({ id: `s3-${sfx}`, chat, text: 'stop' })); await settle(); // already opted out: silent
    expect(enqueueWhatsApp).toHaveBeenCalledTimes(1);

    await post(evt({ id: `s4-${sfx}`, chat, text: 'can you call me' })); await settle();
    expect(hermesService.handleInboundMessage).not.toHaveBeenCalled();
    expect(await prisma.message.count({ where: { externalId: `s4-${sfx}` } })).toBe(1);

    await post(evt({ id: `s5-${sfx}`, chat, text: 'START' })); await settle();
    parent = await prisma.parent.findUnique({ where: { whatsappNumber: phones[3] } });
    expect(parent).toMatchObject({ optedOut: false, optedOutAt: null });
    expect(enqueueWhatsApp).toHaveBeenCalledTimes(2);
  });

  it('survives a Hermes failure after answering 200', async () => {
    vi.mocked(hermesService.handleInboundMessage).mockRejectedValueOnce(new Error('llm down'));
    const res = await post(evt({ id: `h-${sfx}`, chat: jid(phones[4]) }));
    expect(res.status).toBe(200);
    await settle();
    expect(await prisma.message.count({ where: { externalId: `h-${sfx}` } })).toBe(1);
  });
});

describe('/webhooks/meta-leads', () => {
  const sign = (raw: string, secret = SECRET) => 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const leadgenId = `lg-${sfx}`;
  const payload = {
    object: 'page',
    entry: [{ id: 'p1', changes: [{ field: 'leadgen', value: {
      leadgen_id: leadgenId, form_id: 'f1',
      field_data: [
        { name: 'full_name', values: ['Meta Parent'] },
        { name: 'phone_number', values: [`+${phones[5]}`] },
        { name: 'email', values: ['meta@example.com'] },
        { name: 'grade_of_child', values: ['Class 9'] },
      ],
    } }] }],
  };
  const raw = JSON.stringify(payload);
  const send = (body: string, sig?: string) => {
    const r = request(app).post('/webhooks/meta-leads').set('Content-Type', 'application/json');
    return (sig ? r.set('X-Hub-Signature-256', sig) : r).send(body);
  };

  it('rejects missing/invalid signatures and an unset secret', async () => {
    expect((await send(raw)).status).toBe(401);
    expect((await send(raw, sign(raw, 'wrong'))).status).toBe(401);
    expect((await send(raw, 'sha256=zz')).status).toBe(401);
    delete process.env.META_APP_SECRET;
    expect((await send(raw, sign(raw))).status).toBe(503);
    process.env.META_APP_SECRET = SECRET;
  });

  it('creates Parent + Lead(Meta, enquiry) once per leadgen id', async () => {
    const r1 = await send(raw, sign(raw));
    expect(r1.status).toBe(200);
    expect(r1.body.results[0].status).toBe('created');
    const r2 = await send(raw, sign(raw));
    expect(r2.body.results[0].status).toBe('duplicate');

    const parent = await prisma.parent.findUnique({ where: { whatsappNumber: phones[5] } });
    expect(parent).toMatchObject({ fullName: 'Meta Parent', email: 'meta@example.com' });
    const leads = await prisma.lead.findMany({ where: { parentId: parent!.id } });
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({ source: 'Meta', status: 'enquiry' });
    expect(leads[0].requirements).toContain('grade of child: Class 9');
  });

  it('reports leads without a valid phone as rejected (200, explicit)', async () => {
    const bad = JSON.stringify({ entry: [{ changes: [{ field: 'leadgen', value: { leadgen_id: 'x1', field_data: [{ name: 'full_name', values: ['A'] }] } }] }] });
    const res = await send(bad, sign(bad));
    expect(res.status).toBe(200);
    expect(res.body.results[0]).toMatchObject({ status: 'rejected' });
  });

  it('GET handshake needs a configured, matching token', async () => {
    const q = (t: string) => request(app).get('/webhooks/meta-leads').query({ 'hub.mode': 'subscribe', 'hub.verify_token': t, 'hub.challenge': '123' });
    expect((await q('vt')).text).toBe('123');
    expect((await q('bad')).status).toBe(403);
    delete process.env.META_VERIFY_TOKEN;
    expect((await q('vt')).status).toBe(503);
    process.env.META_VERIFY_TOKEN = 'vt';
  });
});
