import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { requireAgentKey } from '../middleware/agent-key.middleware';
import { asyncHandler } from '../utils/async-handler';
import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { normalizePhone } from '../utils/phone';
import { agentToolsService } from '../services/agent-tools.service';
import { aiActivityLogService } from '../services/ai-activity-log.service';
import { buildPersona } from '../services/voice-persona.service';

/**
 * Internal API for the Python voice call agent. Authenticated with X-Agent-Key
 * (EKALAVYA_AGENT_KEY), not a user JWT. Nothing here sends a message on its own.
 */
const router = Router();
router.use(requireAgentKey);

// Booking belongs to DemoCoordinatorAI (see AGENT_PERMISSIONS); everything else is AdmissionsAI.
const VOICE_TOOLS: Record<string, 'AdmissionsAI' | 'DemoCoordinatorAI'> = {
  check_calendar: 'AdmissionsAI',
  book_demo: 'DemoCoordinatorAI',
  qualify_lead: 'AdmissionsAI',
  get_lead: 'AdmissionsAI',
  send_whatsapp_message: 'AdmissionsAI',
  update_lead_status: 'AdmissionsAI',
};

const CALL_ACTOR = 'AdmissionsAI';

function jsonSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

/** Contact details are never handed to the voice LLM. */
function stripContact(result: any): any {
  if (result && typeof result === 'object' && result.parent && typeof result.parent === 'object') {
    const { whatsappNumber: _w, email: _e, address: _a, ...parent } = result.parent;
    return { ...result, parent };
  }
  return result;
}

// ── GET /persona ──────────────────────────────────────────────
router.get('/persona', (_req: Request, res: Response) => {
  res.json(buildPersona());
});

// ── GET /tools ────────────────────────────────────────────────
router.get('/tools', (_req: Request, res: Response) => {
  const byName = new Map<string, { name: string; description: string; parameters: unknown }>();
  for (const agentId of new Set(Object.values(VOICE_TOOLS))) {
    for (const def of agentToolsService.getToolDefinitions(agentId)) {
      if (VOICE_TOOLS[def.name] === agentId) byName.set(def.name, def);
    }
  }
  const tools = Object.keys(VOICE_TOOLS)
    .filter((n) => byName.has(n))
    .map((n) => {
      const def = byName.get(n)!;
      return { type: 'function', function: { name: def.name, description: def.description, parameters: def.parameters } };
    });
  res.json({ tools });
});

// ── POST /tools/:name ─────────────────────────────────────────
const ToolBody = z.object({
  args: z.record(z.unknown()).default({}),
  callId: z.string().min(1).max(64),
  leadId: z.string().uuid().optional(),
});

router.post('/tools/:name', asyncHandler(async (req, res) => {
  const name = req.params.name;
  const agentId = Object.prototype.hasOwnProperty.call(VOICE_TOOLS, name) ? VOICE_TOOLS[name] : undefined;
  if (!agentId) {
    res.status(404).json({ ok: false, error: `Unknown tool '${name}'` });
    return;
  }
  const parsed = ToolBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
    return;
  }
  const { args, callId, leadId } = parsed.data;

  // callId rides in the args so the audit row written by executeTool carries it.
  const toolArgs = { ...args, callId };
  await aiActivityLogService.log({
    agentId, targetId: leadId, actionType: 'voice_tool_call', payload: { tool: name, callId }, status: 'pending',
  });

  try {
    const result = await agentToolsService.executeTool(agentId, name, toolArgs, leadId ? { leadId } : undefined);
    res.json({ ok: true, result: jsonSafe(stripContact(result)) });
  } catch (err) {
    // Tool failures (validation, permission, guardrail) are data for the model, not server errors.
    res.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}));

// ── POST /calls/identify ──────────────────────────────────────
const IdentifyBody = z.object({ phone: z.string().min(1).max(40) });

router.post('/calls/identify', asyncHandler(async (req, res) => {
  const parsed = IdentifyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'phone is required' });
    return;
  }
  const phone = normalizePhone(parsed.data.phone);
  if (!phone) {
    res.status(400).json({ error: 'phone is not a valid phone number' });
    return;
  }

  const parent = await prisma.parent.findUnique({
    where: { whatsappNumber: phone },
    select: {
      id: true,
      fullName: true,
      students: { select: { id: true, fullName: true } },
      leads: {
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, status: true, gradeInterested: true, boardInterested: true, subjectsInterested: true,
          appointments: {
            where: { status: 'scheduled', scheduledAt: { gte: new Date() } },
            orderBy: { scheduledAt: 'asc' },
            take: 1,
            select: { id: true, leadId: true, scheduledAt: true, durationMinutes: true, status: true },
          },
        },
      },
    },
  });

  if (!parent) {
    res.json({ parent: null, lead: null, openAppointment: null, students: [] });
    return;
  }

  const lead = parent.leads[0] ?? null;
  const appointments = parent.leads.flatMap((l) => l.appointments).sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
  res.json({
    parent: { id: parent.id, fullName: parent.fullName },
    lead: lead && {
      id: lead.id,
      status: lead.status,
      gradeInterested: lead.gradeInterested,
      boardInterested: lead.boardInterested,
      subjectsInterested: lead.subjectsInterested,
    },
    openAppointment: appointments[0] ?? null,
    students: parent.students,
  });
}));

// ── POST /call-log ────────────────────────────────────────────
export const CALL_OUTCOMES = ['demo_booked', 'callback_requested', 'not_interested', 'info_only', 'dropped', 'unknown'] as const;

const CallLogBody = z.object({
  callId: z.string().min(1).max(64),
  phone: z.string().max(40).optional(),
  leadId: z.string().uuid().optional(),
  startedAt: z.string().datetime({ offset: true }),
  endedAt: z.string().datetime({ offset: true }),
  durationSec: z.number().int().min(0).max(86400),
  transcript: z.array(z.object({
    role: z.enum(['agent', 'caller']),
    text: z.string().max(5000),
    ts: z.union([z.string().max(64), z.number()]),
  })).max(2000),
  outcome: z.enum(CALL_OUTCOMES).optional(),
  summary: z.string().max(5000).optional(),
});

const MESSAGE_BODY_MAX = 2000;

router.post('/call-log', asyncHandler(async (req, res) => {
  const parsed = CallLogBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
    return;
  }
  const b = parsed.data;

  const phone = b.phone ? normalizePhone(b.phone) : null;
  let leadId: string | null = null;
  let parentId: string | null = null;

  if (b.leadId) {
    const lead = await prisma.lead.findUnique({ where: { id: b.leadId }, select: { id: true, parentId: true } });
    if (!lead) {
      res.status(404).json({ error: `Lead ${b.leadId} not found` });
      return;
    }
    leadId = lead.id;
    parentId = lead.parentId;
  } else if (phone) {
    const parent = await prisma.parent.findUnique({
      where: { whatsappNumber: phone },
      select: { id: true, leads: { orderBy: { createdAt: 'desc' }, take: 1, select: { id: true } } },
    });
    if (parent) {
      parentId = parent.id;
      leadId = parent.leads[0]?.id ?? null;
    }
  }

  const parent = parentId ? await prisma.parent.findUnique({ where: { id: parentId }, select: { optedOut: true } }) : null;
  const optedOut = parent?.optedOut ?? false;

  const existing = await prisma.callLog.findUnique({ where: { callId: b.callId }, select: { id: true } });
  const data = {
    parentId,
    leadId,
    phone,
    transcript: b.transcript as unknown as Prisma.InputJsonValue,
    summary: b.summary ?? null,
    outcome: b.outcome ?? null,
    durationSec: b.durationSec,
  };
  const call = await prisma.callLog.upsert({
    where: { callId: b.callId },
    create: { callId: b.callId, ...data, createdAt: new Date(b.startedAt) },
    // A repeat post must never erase links a previous post resolved (e.g. when it omits the phone).
    update: {
      ...data,
      parentId: parentId ?? undefined,
      leadId: leadId ?? undefined,
      phone: phone ?? undefined,
      summary: b.summary ?? undefined,
      outcome: b.outcome ?? undefined,
    },
  });

  // One inbound Message per call (externalId makes repeats idempotent). It records, it never sends.
  let messageStored = false;
  if (parentId || leadId) {
    const transcriptText = b.transcript.map((t) => `${t.role}: ${t.text}`).join('\n');
    const body = (b.summary?.trim() || transcriptText || 'Voice call (no transcript)').slice(0, MESSAGE_BODY_MAX);
    const status = optedOut ? 'logged:opted_out' : 'logged';
    await prisma.message.upsert({
      where: { externalId: `call:${b.callId}` },
      create: { parentId, leadId, direction: 'inbound', channel: 'call', body, status, externalId: `call:${b.callId}` },
      update: { parentId: parentId ?? undefined, leadId: leadId ?? undefined, body, status },
    });
    messageStored = true;
  }

  if (!existing) {
    await aiActivityLogService.log({
      agentId: CALL_ACTOR,
      targetId: leadId ?? parentId ?? b.callId,
      actionType: 'voice_call_completed',
      payload: {
        callId: b.callId,
        startedAt: b.startedAt,
        endedAt: b.endedAt,
        durationSec: b.durationSec,
        outcome: b.outcome ?? null,
        turns: b.transcript.length,
        parentId,
        leadId,
        optedOut,
      },
      status: 'success',
    });
  }
  logger.info('Voice call logged', { callId: b.callId, leadId, parentId, optedOut, created: !existing });

  res.status(existing ? 200 : 201).json({
    id: call.id,
    callId: call.callId,
    parentId,
    leadId,
    created: !existing,
    optedOut,
    messageStored,
    phoneValid: b.phone === undefined ? undefined : phone !== null,
  });
}));

export default router;
