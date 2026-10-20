import express, { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { asyncHandler } from '../utils/async-handler';
import { normalizePhone } from '../utils/phone';
import { hermesService } from '../services/hermes.service';
import { enqueueWhatsApp, OPT_OUT_CONFIRMATION_KIND } from '../utils/queues';

const router = Router();

// ── Shared helpers ────────────────────────────────────────────

/** Constant-time string comparison (hashes first so differing lengths do not leak). */
export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function headerValue(req: Request, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

// ── Evolution GO inbound ──────────────────────────────────────

type AuthResult = 'ok' | 'unconfigured' | 'invalid';

/**
 * Evolution GO cannot add custom headers to its webhook calls, but every event body carries
 * `instanceToken` (the same token we use as the `apikey` when sending). We accept that token from
 * the body, or an `apikey` / `x-api-key` header when a reverse proxy injects one. Never the query string.
 */
export function verifyEvolutionGoAuth(req: Request): AuthResult {
  const expected = process.env.EVOLUTION_GO_API_KEY;
  if (!expected) return 'unconfigured';
  const provided = headerValue(req, 'apikey') ?? headerValue(req, 'x-api-key') ?? req.body?.instanceToken;
  if (typeof provided !== 'string' || !provided) return 'invalid';
  return safeEqual(provided, expected) ? 'ok' : 'invalid';
}

export interface ParsedGatewayMessage {
  id: string;
  fromMe: boolean;
  isGroup: boolean;
  chat: string;
  senderAlt?: string;
  pushName?: string;
  text: string;
  timestamp?: Date;
}

/** Parses Evolution GO `Message` / `SendMessage` event data ({ Info, Message }). Returns null if malformed. */
export function parseGatewayMessage(data: any): ParsedGatewayMessage | null {
  const info = data?.Info;
  if (!info || typeof info.ID !== 'string' || typeof info.Chat !== 'string') return null;
  const m = data?.Message ?? {};
  const text: string =
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.videoMessage?.caption ??
    m.documentMessage?.caption ??
    '';
  const ts = info.Timestamp ? new Date(info.Timestamp) : undefined;
  return {
    id: info.ID,
    fromMe: info.IsFromMe === true,
    isGroup: info.IsGroup === true || /@(g\.us|broadcast|newsletter)$/.test(info.Chat),
    chat: info.Chat,
    senderAlt: typeof info.SenderAlt === 'string' ? info.SenderAlt : undefined,
    pushName: typeof info.PushName === 'string' && info.PushName ? info.PushName : undefined,
    text: typeof text === 'string' ? text.trim() : '',
    timestamp: ts && !isNaN(ts.getTime()) ? ts : undefined,
  };
}

// Whole-message keywords only, so "please don't stop the classes" never opts anyone out.
const OPT_OUT_KEYWORDS = new Set([
  'stop', 'stop all', 'unsubscribe', 'opt out', 'optout',
  'बंद करो', 'बंद करें', 'रुको', 'रोको',      // Hindi: stop / stop (formal) / halt / stop
  'band karo', 'ruk jao',                       // Hindi, romanised
  'நிறுத்து', 'நிறுத்துங்கள்', 'நிறுத்துங்க',   // Tamil: stop / stop (formal) / stop (colloquial)
  'niruthu', 'nirutthu',                        // Tamil, romanised
]);
const OPT_IN_KEYWORDS = new Set([
  'start', 'subscribe', 'opt in', 'optin', 'unstop',
  'शुरू करो', 'शुरू करें',                      // Hindi: start
  'தொடங்கு', 'தொடங்குங்கள்',                    // Tamil: start
]);

function normalizeKeyword(text: string): string {
  return text.toLowerCase().replace(/[.!,?;:'"“”‘’।]+/g, '').replace(/\s+/g, ' ').trim();
}
export function matchOptKeyword(text: string): 'opt_out' | 'opt_in' | null {
  const k = normalizeKeyword(text);
  if (OPT_OUT_KEYWORDS.has(k)) return 'opt_out';
  if (OPT_IN_KEYWORDS.has(k)) return 'opt_in';
  return null;
}

const OPT_OUT_REPLY = 'You have been unsubscribed from E-Kalavya WhatsApp messages and will not receive any more. Reply START anytime to subscribe again.';
const OPT_IN_REPLY = 'Welcome back! You are subscribed to E-Kalavya WhatsApp messages again. Reply STOP anytime to unsubscribe.';

/** Serialises work per key across API instances (e.g. two messages from one new contact arriving together). */
async function withAdvisoryLock<T>(key: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
    return fn(tx);
  });
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/** Handles one gateway event after the HTTP response has been sent. Throws on genuine failures (caller logs). */
export async function processEvolutionEvent(payload: any): Promise<void> {
  const event: string | undefined = payload?.event;

  if (event === 'LoggedOut' || event === 'TemporaryBan') {
    logger.error(`WhatsApp gateway event ${event}: the linked WhatsApp session needs attention`, { data: payload?.data });
    return;
  }
  if (event !== 'Message' && event !== 'SendMessage') return;

  const msg = parseGatewayMessage(payload.data);
  if (!msg) {
    logger.warn('Evolution GO webhook: unparseable message payload', { event });
    return;
  }
  if (msg.isGroup) return;
  if (!msg.text) {
    logger.debug('Evolution GO webhook: non-text message ignored', { id: msg.id });
    return;
  }

  if (msg.fromMe) {
    await recordOwnMessage(msg);
    return;
  }

  // Counterpart number: the chat JID, or its phone-number alias when WhatsApp hides it behind a @lid.
  const phone = normalizePhone(msg.chat) ?? (msg.senderAlt ? normalizePhone(msg.senderAlt) : null);
  if (!phone) {
    logger.warn('Evolution GO webhook: cannot derive a phone number from sender', { chat: msg.chat });
    return;
  }

  if (await prisma.message.findUnique({ where: { externalId: msg.id }, select: { id: true } })) return; // gateway retry

  const { parent, lead, wasOptedOut } = await withAdvisoryLock(`wa:${phone}`, async (tx) => {
    const existing = await tx.parent.findUnique({ where: { whatsappNumber: phone } });
    const parent = existing
      ? (existing.fullName === 'Unknown' && msg.pushName
          ? await tx.parent.update({ where: { id: existing.id }, data: { fullName: msg.pushName } })
          : existing)
      : await tx.parent.create({ data: { fullName: msg.pushName ?? 'Unknown', whatsappNumber: phone } });

    let lead = await tx.lead.findFirst({
      where: { parentId: parent.id, status: { notIn: ['converted', 'lost'] } },
      orderBy: { createdAt: 'desc' },
    });
    // Organic WhatsApp contacts have no matching LeadSource value, so source stays null.
    if (!lead) {
      lead = await tx.lead.create({
        data: { parentId: parent.id, source: null, status: 'enquiry', assignedAgentId: 'AdmissionsAI' },
      });
      logger.info('New lead auto-created from WhatsApp', { leadId: lead.id, from: phone });
    }
    return { parent, lead, wasOptedOut: parent.optedOut };
  });

  try {
    await prisma.message.create({
      data: {
        parentId: parent.id,
        leadId: lead.id,
        direction: 'inbound',
        channel: 'whatsapp',
        body: msg.text,
        status: 'received',
        externalId: msg.id,
        ...(msg.timestamp ? { createdAt: msg.timestamp } : {}),
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) return; // concurrent duplicate delivery
    throw err;
  }

  const keyword = matchOptKeyword(msg.text);
  if (keyword === 'opt_out' || keyword === 'opt_in') {
    const optOut = keyword === 'opt_out';
    if (optOut === wasOptedOut) return; // already in that state: stay quiet, confirm only once
    await prisma.parent.update({
      where: { id: parent.id },
      data: optOut ? { optedOut: true, optedOutAt: new Date() } : { optedOut: false, optedOutAt: null },
    });
    logger.info(`Parent ${optOut ? 'opted out of' : 'opted back in to'} WhatsApp messages`, { parentId: parent.id });
    await enqueueWhatsApp({
      to: phone,
      text: optOut ? OPT_OUT_REPLY : OPT_IN_REPLY,
      agentId: 'MessagingSystem',
      targetId: lead.id,
      parentId: parent.id,
      leadId: lead.id,
      messageKind: OPT_OUT_CONFIRMATION_KIND,
    });
    return;
  }

  if (wasOptedOut) {
    logger.info('Inbound message from opted-out parent stored; no automated reply sent', { parentId: parent.id });
    return;
  }

  await hermesService.handleInboundMessage({
    fromNumber: phone,
    textContent: msg.text,
    parentId: parent.id,
    leadId: lead.id,
  });
}

/** Messages sent from the linked phone itself (or echoed by the gateway's SendMessage event). */
async function recordOwnMessage(msg: ParsedGatewayMessage): Promise<void> {
  const phone = normalizePhone(msg.chat);
  if (!phone) return;
  const parent = await prisma.parent.findUnique({ where: { whatsappNumber: phone }, select: { id: true } });
  if (!parent) return; // not a contact we track; never create leads from our own outgoing chat
  const lead = await prisma.lead.findFirst({
    where: { parentId: parent.id, status: { notIn: ['converted', 'lost'] } },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  try {
    await prisma.message.create({
      data: {
        parentId: parent.id,
        leadId: lead?.id ?? null,
        direction: 'outbound',
        channel: 'whatsapp',
        body: msg.text,
        status: 'sent',
        externalId: msg.id,
        ...(msg.timestamp ? { createdAt: msg.timestamp } : {}),
      },
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err; // already stored by the send worker
  }
}

/**
 * POST /webhooks/evolution-go
 * Receives WhatsApp events from Evolution GO.
 */
router.post('/evolution-go', asyncHandler(async (req: Request, res: Response) => {
  const auth = verifyEvolutionGoAuth(req);
  if (auth === 'unconfigured') {
    logger.error('Evolution Go webhook rejected: EVOLUTION_GO_API_KEY is not configured');
    return void res.status(503).json({ error: 'Webhook not configured' });
  }
  if (auth === 'invalid') {
    logger.warn('Unauthorized Evolution Go webhook attempt blocked');
    return void res.status(401).json({ error: 'Unauthorized: Invalid or missing webhook credentials' });
  }

  // Acknowledge immediately (the gateway retries slow or failing webhooks)
  res.sendStatus(200);

  try {
    await processEvolutionEvent(req.body);
  } catch (error: any) {
    logger.error('Evolution Go webhook processing failed', { error: error?.message, event: req.body?.event });
  }
}));

// ── Meta Lead Ads ─────────────────────────────────────────────

/**
 * Meta lead-ads webhook. Exported separately because it must be mounted BEFORE the global
 * express.json() in app.ts: the X-Hub-Signature-256 HMAC is computed over the raw bytes, so this
 * router parses its own body with express.raw().
 */
export const metaLeadsRouter = Router();

export function verifyMetaSignature(rawBody: Buffer, signatureHeader: string | undefined, appSecret: string): boolean {
  if (!signatureHeader) return false;
  const [scheme, hash] = signatureHeader.split('=');
  if (scheme !== 'sha256' || !hash || !/^[0-9a-f]{64}$/i.test(hash)) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest();
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), expected);
}

interface MetaFieldData { name: string; values?: string[] }

export interface MetaLeadResult {
  leadgenId: string;
  status: 'created' | 'duplicate' | 'rejected';
  leadId?: string;
  reason?: string;
}

/** Fetches the lead's answers from the Graph API (Meta's webhook only carries the leadgen id). */
async function fetchMetaLeadFields(leadgenId: string): Promise<MetaFieldData[]> {
  const token = process.env.META_PAGE_ACCESS_TOKEN;
  if (!token) throw new Error('META_PAGE_ACCESS_TOKEN is not configured: cannot fetch lead field data from Meta');
  const version = process.env.META_GRAPH_API_VERSION ?? 'v21.0';
  const resp = await fetch(
    `https://graph.facebook.com/${version}/${encodeURIComponent(leadgenId)}?fields=field_data`,
    { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) },
  );
  const body: any = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`Meta Graph API error ${resp.status}: ${body?.error?.message ?? 'unknown'}`);
  if (!Array.isArray(body.field_data)) throw new Error('Meta Graph API returned no field_data');
  return body.field_data;
}

/** Creates (idempotently, per leadgen id) the Parent + Lead for one Meta lead. */
export async function createLeadFromMeta(value: any): Promise<MetaLeadResult> {
  const leadgenId = String(value?.leadgen_id ?? '');
  if (!leadgenId) return { leadgenId, status: 'rejected', reason: 'missing leadgen_id' };

  const fields: MetaFieldData[] = Array.isArray(value.field_data) ? value.field_data : await fetchMetaLeadFields(leadgenId);
  const get = (n: string) => fields.find((f) => f.name === n)?.values?.[0]?.trim();
  const fullName = get('full_name') ?? ([get('first_name'), get('last_name')].filter(Boolean).join(' ') || undefined);
  const phone = normalizePhone(get('phone_number') ?? get('phone'));
  const email = get('email');
  if (!phone) return { leadgenId, status: 'rejected', reason: 'no valid phone_number in lead' };

  const answers = fields
    .filter((f) => !['full_name', 'first_name', 'last_name', 'phone_number', 'phone', 'email'].includes(f.name))
    .map((f) => `${f.name.replace(/_/g, ' ')}: ${(f.values ?? []).join(', ')}`)
    .filter((l) => !l.endsWith(': '));
  const marker = `meta_leadgen_id=${leadgenId}`;
  const notes = [marker, value.form_id ? `form_id=${value.form_id}` : null, value.ad_id ? `ad_id=${value.ad_id}` : null]
    .filter(Boolean).join(' ');

  return withAdvisoryLock(marker, async (tx) => {
    const dup = await tx.lead.findFirst({ where: { source: 'Meta', OR: [{ notes: marker }, { notes: { startsWith: `${marker} ` } }] }, select: { id: true } });
    if (dup) return { leadgenId, status: 'duplicate' as const, leadId: dup.id };

    const existing = await tx.parent.findUnique({ where: { whatsappNumber: phone } });
    const parent = existing
      ? await tx.parent.update({
          where: { id: existing.id },
          data: {
            ...(existing.fullName === 'Unknown' && fullName ? { fullName } : {}),
            ...(!existing.email && email ? { email } : {}),
          },
        })
      : await tx.parent.create({ data: { fullName: fullName ?? 'Unknown', whatsappNumber: phone, email: email ?? null } });

    const lead = await tx.lead.create({
      data: {
        parentId: parent.id,
        source: 'Meta',
        status: 'enquiry',
        requirements: answers.length ? answers.join('\n') : null,
        notes,
        assignedAgentId: 'AdmissionsAI',
      },
    });
    return { leadgenId, status: 'created' as const, leadId: lead.id };
  });
}

/** Collects every leadgen change from Meta's `entry[].changes[]` envelope (or a bare `{ field, value }`). */
function extractLeadgenValues(body: any): any[] {
  const changes: any[] = Array.isArray(body?.entry)
    ? body.entry.flatMap((e: any) => (Array.isArray(e?.changes) ? e.changes : []))
    : body?.field ? [body] : [];
  return changes.filter((c) => c?.field === 'leadgen' && c.value).map((c) => c.value);
}

metaLeadsRouter.get('/', (req: Request, res: Response) => {
  const expected = process.env.META_VERIFY_TOKEN;
  if (!expected) {
    logger.error('Meta webhook handshake rejected: META_VERIFY_TOKEN is not configured');
    return void res.sendStatus(503);
  }
  const token = req.query['hub.verify_token'];
  if (req.query['hub.mode'] === 'subscribe' && typeof token === 'string' && safeEqual(token, expected)) {
    return void res.status(200).send(String(req.query['hub.challenge'] ?? ''));
  }
  logger.warn('Meta webhook handshake verification failed: token mismatch');
  res.sendStatus(403);
});

metaLeadsRouter.post('/', express.raw({ type: '*/*', limit: '1mb' }), asyncHandler(async (req: Request, res: Response) => {
  const appSecret = process.env.META_APP_SECRET || process.env.WHATSAPP_APP_SECRET;
  if (!appSecret) {
    logger.error('Meta webhook rejected: META_APP_SECRET is not configured');
    return void res.status(503).json({ error: 'Webhook not configured' });
  }
  const raw = req.body;
  if (!Buffer.isBuffer(raw)) {
    return void res.status(400).json({ error: 'Expected a raw request body' });
  }
  if (!verifyMetaSignature(raw, headerValue(req, 'x-hub-signature-256'), appSecret)) {
    logger.warn('Unauthorized Meta webhook attempt blocked: invalid signature');
    return void res.status(401).json({ error: 'Invalid X-Hub-Signature-256' });
  }

  let body: any;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    return void res.status(400).json({ error: 'Body is not valid JSON' });
  }

  const values = extractLeadgenValues(body);
  const results: MetaLeadResult[] = [];
  for (const value of values) {
    try {
      const r = await createLeadFromMeta(value);
      if (r.status === 'rejected') logger.error('Meta lead rejected', r);
      else logger.info(`Meta lead ${r.status}`, r);
      results.push(r);
    } catch (err: any) {
      // Transient failure (Graph API / DB): answer 5xx so Meta redelivers; already-created leads are idempotent.
      logger.error('Meta lead processing failed', { leadgenId: value?.leadgen_id, error: err.message });
      return void res.status(502).json({ error: 'Failed to process lead', leadgenId: value?.leadgen_id, details: err.message });
    }
  }
  res.status(200).json({ received: values.length, results });
}));

export default router;
