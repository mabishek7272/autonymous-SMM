import { prisma } from '../utils/database';
import { redis } from '../utils/redis';
import { logger } from '../utils/logger';
import { aiActivityLogService } from './ai-activity-log.service';
import { agentToolsService } from './agent-tools.service';
import { enqueueWhatsApp } from '../utils/queues';
import { llmMonitorService } from './llm-monitor.service';

export interface InboundMessageContext {
  fromNumber: string;
  textContent: string;
  parentId: string;
  leadId: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

type LlmProvider = 'ollama' | 'openai' | 'openrouter' | 'hub';

export interface LlmConfig {
  provider: LlmProvider;
  url: string;
  model: string;
  headers: Record<string, string>;
  timeoutMs: number;
}

/** OpenAI-format chat message, including tool-calling turns. */
interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

interface LlmUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

interface LlmRunResult {
  text: string;
  handoff?: { preferredSlot?: string; note?: string };
}

const MAX_TOOL_ITERATIONS = 4;
const MAX_TOOL_CALLS_PER_ITERATION = 5;

/** Agents that converse directly with parents over WhatsApp — picked for low-latency, conversational models. */
const CUSTOMER_FACING_AGENTS = new Set(['AdmissionsAI', 'DemoCoordinatorAI', 'ParentEngagementAI']);

/** Picks the OpenRouter model for an agent: an explicit OPENROUTER_MODEL always wins; otherwise
 *  customer-facing WhatsApp personas get the chat-tuned model and internal/orchestration agents
 *  (ChiefOfStaffAI, AcademicMonitoringAI, ReportingAnalyticsAI) get the tool/JSON-tuned one. */
export function pickOpenRouterModel(agentId: string): string {
  if (process.env.OPENROUTER_MODEL) return process.env.OPENROUTER_MODEL;
  return CUSTOMER_FACING_AGENTS.has(agentId)
    ? process.env.OPENROUTER_MODEL_CUSTOMER_FACING || 'qwen/qwen3.8-flash'
    : process.env.OPENROUTER_MODEL_BACKEND || 'z-ai/glm-5.3-flash';
}

/**
 * Provider selection, read from env at call time (the dev console changes env at runtime).
 * USE_REAL_LLM=false or LLM_PROVIDER=deterministic force the rule engine. A real provider
 * missing its credentials also resolves to deterministic, with the reason returned.
 */
export function resolveLlmConfig(agentId: string): { config?: LlmConfig; deterministicReason?: string } {
  if (process.env.USE_REAL_LLM === 'false') {
    return { deterministicReason: 'USE_REAL_LLM=false' };
  }
  const provider = (process.env.LLM_PROVIDER || 'ollama').toLowerCase();
  const timeoutMs = parseInt(process.env.LLM_REQUEST_TIMEOUT_MS || process.env.OLLAMA_REQUEST_TIMEOUT_MS || '60000', 10);
  const base: Pick<LlmConfig, 'headers' | 'timeoutMs'> = { headers: { 'Content-Type': 'application/json' }, timeoutMs };

  switch (provider) {
    case 'ollama':
      return {
        config: {
          ...base,
          provider,
          url: `${(process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/$/, '')}/v1/chat/completions`,
          model: process.env.OLLAMA_MODEL || 'qwen3.8:27b',
        },
      };
    case 'openai': {
      const key = process.env.OPENAI_API_KEY;
      if (!key) return { deterministicReason: 'LLM_PROVIDER=openai but OPENAI_API_KEY is not set' };
      return {
        config: {
          ...base,
          provider,
          url: `${(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '')}/chat/completions`,
          model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
          headers: { ...base.headers, Authorization: `Bearer ${key}` },
        },
      };
    }
    case 'openrouter': {
      const key = process.env.OPENROUTER_API_KEY;
      if (!key) return { deterministicReason: 'LLM_PROVIDER=openrouter but OPENROUTER_API_KEY is not set' };
      return {
        config: {
          ...base,
          provider,
          url: `${(process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '')}/chat/completions`,
          model: pickOpenRouterModel(agentId),
          headers: {
            ...base.headers,
            Authorization: `Bearer ${key}`,
            'HTTP-Referer': 'https://ekalavya.in',
            'X-Title': 'E-Kalavya Academy',
          },
        },
      };
    }
    case 'hub': {
      const key = process.env.HUB_API_KEY;
      if (!key) return { deterministicReason: 'LLM_PROVIDER=hub but HUB_API_KEY is not set' };
      return {
        config: {
          ...base,
          provider,
          url: `${(process.env.HUB_BASE_URL || 'https://hub.amgi.in/v1').replace(/\/$/, '')}/chat/completions`,
          model: process.env.HUB_MODEL || 'glm-4.7-flash',
          headers: { ...base.headers, Authorization: `Bearer ${key}` },
        },
      };
    }
    case 'deterministic':
      return { deterministicReason: 'LLM_PROVIDER=deterministic' };
    default:
      return { deterministicReason: `Unknown LLM_PROVIDER '${provider}'` };
  }
}

function istNow(): string {
  return new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'short' });
}

function istDayLabel(d: Date): string {
  return d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short' });
}

function istTimeLabel(d: Date): string {
  return d.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
}

/** Picks the offered slot a parent referred to ("11:30", "2 pm", "3"), or undefined. */
function pickSlot<T extends { time: string }>(text: string, slots: T[]): T | undefined {
  const re = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const h = parseInt(m[1], 10);
    const min = m[2] ? parseInt(m[2], 10) : 0;
    const mer = m[3]?.toLowerCase();
    if (h > 23 || min > 59) continue;
    const candidates: number[] = [];
    if (mer === 'pm') candidates.push(h < 12 ? h + 12 : h);
    else if (mer === 'am') candidates.push(h === 12 ? 0 : h);
    else candidates.push(h, h < 12 ? h + 12 : h);
    for (const c of candidates) {
      const hit = slots.find((s) => s.time === `${String(c).padStart(2, '0')}:${String(min).padStart(2, '0')}`);
      if (hit) return hit;
    }
  }
  return undefined;
}

export class HermesService {
  private readonly redisKeyPrefix = 'ekalavya:chat:lead:';

  /**
   * Redis chat cache (7-day TTL). A convenience only: the Message table is the system of record.
   */
  private async getHistory(leadId: string): Promise<ChatMessage[]> {
    try {
      const data = await redis.get(`${this.redisKeyPrefix}${leadId}`);
      if (data) {
        return JSON.parse(data) as ChatMessage[];
      }
    } catch (err) {
      logger.warn(`Redis get error for lead ${leadId}, fallback to empty history`, { err });
    }
    return [];
  }

  private async appendHistory(leadId: string, messages: ChatMessage[]): Promise<void> {
    try {
      const history = await this.getHistory(leadId);
      const updated = [...history, ...messages].slice(-30); // keep last 30 turns
      await redis.set(`${this.redisKeyPrefix}${leadId}`, JSON.stringify(updated), 'EX', 7 * 86400);
    } catch (err) {
      logger.warn(`Redis set error for lead ${leadId}`, { err });
    }
  }

  /**
   * Conversation history for the model. Prefers the Message table; falls back to the Redis
   * cache only when the table holds no inbound turns for this lead (e.g. first contact).
   */
  private async loadHistory(leadId: string, currentText: string): Promise<ChatMessage[]> {
    let history: ChatMessage[] = [];
    try {
      const rows = await prisma.message.findMany({
        where: { leadId, channel: 'whatsapp' },
        orderBy: { createdAt: 'desc' },
        take: 20,
      });
      if (rows.some((r) => r.direction === 'inbound')) {
        history = rows
          .reverse()
          .map((r) => ({ role: r.direction === 'inbound' ? ('user' as const) : ('assistant' as const), content: r.body }));
      }
    } catch (err) {
      logger.warn(`Message history load failed for lead ${leadId}`, { err });
    }
    if (history.length === 0) history = await this.getHistory(leadId);

    const last = history[history.length - 1];
    if (!last || last.role !== 'user' || last.content !== currentText) {
      history.push({ role: 'user', content: currentText });
    }
    return history;
  }

  /**
   * Main entrypoint for processing incoming WhatsApp messages
   */
  async handleInboundMessage(ctx: InboundMessageContext): Promise<string> {
    const { fromNumber, textContent, leadId } = ctx;
    logger.info(`Hermes routing message for lead ${leadId}: "${textContent.slice(0, 60)}"`);

    // 1. Fetch current lead state
    const lead = await prisma.lead.findUnique({
      where: { id: leadId },
      include: {
        parent: true,
        appointments: { where: { status: 'scheduled' }, orderBy: { scheduledAt: 'desc' }, take: 1 },
      },
    });

    if (!lead) {
      logger.error(`Lead not found for ID ${leadId}`);
      return 'Lead not found';
    }

    // A parent who opted out gets no automated replies.
    if (lead.parent.optedOut) {
      await aiActivityLogService.log({
        agentId: lead.assignedAgentId || 'AdmissionsAI',
        targetId: leadId,
        actionType: 'reply_suppressed_opted_out',
        payload: { leadId },
        status: 'success',
      });
      return '';
    }

    // 2. Pick the agent: DemoCoordinatorAI once the lead was handed off or has a demo, else AdmissionsAI
    let agentId =
      lead.assignedAgentId === 'DemoCoordinatorAI' || lead.status === 'demo_scheduled' || lead.appointments.length > 0
        ? 'DemoCoordinatorAI'
        : 'AdmissionsAI';

    // 3. Conversation history
    const history = await this.loadHistory(leadId, textContent);

    // 4. Compose the reply: real LLM with tool calling, or the labelled rule engine
    let replyText = '';
    const { config, deterministicReason } = resolveLlmConfig(agentId);

    if (config) {
      try {
        const composed = await this.composeWithLlm(config, agentId, lead, history);
        replyText = composed.text;
        agentId = composed.agentId; // the agent that actually wrote the reply
      } catch (error) {
        const reason = `LLM failed: ${error instanceof Error ? error.message : String(error)}`;
        logger.error('LLM reply failed, using deterministic engine', { error });
        replyText = await this.composeDeterministic(agentId, lead, textContent, reason);
      }
    } else {
      replyText = await this.composeDeterministic(agentId, lead, textContent, deterministicReason ?? 'deterministic');
    }

    // 5. Persist the outbound turn (system of record) and the Redis cache
    const outbound = await prisma.message.create({
      data: {
        leadId,
        parentId: lead.parentId,
        direction: 'outbound',
        channel: 'whatsapp',
        body: replyText,
        status: 'queued',
        agentId,
      },
    });
    await this.appendHistory(leadId, [
      { role: 'user', content: textContent },
      { role: 'assistant', content: replyText },
    ]);

    // 6. Queue outgoing message via WhatsApp queue
    try {
      await enqueueWhatsApp({ to: fromNumber, text: replyText, agentId, targetId: leadId, messageId: outbound.id });
    } catch (err) {
      await prisma.message.update({ where: { id: outbound.id }, data: { status: 'failed:enqueue' } });
      throw err;
    }

    logger.info(`Hermes successfully replied to lead ${leadId} via ${agentId}`);
    return replyText;
  }

  // ── Deterministic engine ─────────────────────────────────────

  private async composeDeterministic(agentId: string, lead: any, userText: string, reason: string): Promise<string> {
    const reply = await this.executeAutonomousEngine(agentId, lead, userText);
    await aiActivityLogService.log({
      agentId,
      targetId: lead.id,
      actionType: 'reply_deterministic',
      payload: { reason, preview: reply.slice(0, 120) },
      status: 'success',
    });
    return reply;
  }

  /**
   * Rule-based conversational engine. Every tool call is tagged '_deterministic' in the audit
   * log, and a reply only claims an outcome (e.g. a booked demo) after the tool really succeeded.
   */
  private async executeAutonomousEngine(agentId: string, lead: any, userText: string): Promise<string> {
    const textLower = userText.toLowerCase();
    const tool = (as: string, name: string, args: Record<string, any>) =>
      agentToolsService.executeTool(as, name, args, { variant: 'deterministic', leadId: lead.id });

    // ── DEMO COORDINATOR FLOW ──────────────────────────────────
    if (agentId === 'DemoCoordinatorAI') {
      const activeAppt = lead.appointments?.[0];

      if (activeAppt && !/\b(reschedule|change)\b/.test(textLower)) {
        if (/\b(confirm|yes|sure|ok|okay)\b/.test(textLower)) {
          const at = new Date(activeAppt.scheduledAt);
          return `Your demo class is confirmed for ${istDayLabel(at)} at ${istTimeLabel(at)} IST. Please keep a notebook ready!`;
        }
        return `Hello! This is E-Kalavya Demo Support. Your demo is currently scheduled. Do you have any questions or would you like to reschedule your slot?`;
      }

      // No demo yet, or the parent wants to move it: show real open slots
      let slots: Array<{ time: string; iso: string; formatted: string }> = [];
      let date = '';
      try {
        const cal = await tool('DemoCoordinatorAI', 'check_calendar', {});
        slots = cal.availableSlots;
        date = cal.date;
      } catch {
        return `Sorry, I couldn't check the calendar just now. I'll get back to you shortly with open demo slots.`;
      }
      if (slots.length === 0) return `We don't have any open demo slots on the next available day. I'll check other days and message you soon.`;

      const chosen = !activeAppt ? pickSlot(userText, slots) : undefined;
      if (chosen) {
        try {
          await tool('DemoCoordinatorAI', 'book_demo', { leadId: lead.id, scheduledAt: chosen.iso, durationMinutes: 30 });
          return `Done! Your free demo class is booked for ${istDayLabel(new Date(chosen.iso))} at ${chosen.formatted}. We'll share the teacher details and joining link before class.`;
        } catch {
          return `I couldn't lock in the ${chosen.formatted} slot (it may have just been taken). Could you pick another time from: ${slots.filter((s) => s !== chosen).slice(0, 3).map((s) => s.formatted).join(', ')}?`;
        }
      }
      return `Sure! We have slots on ${date} at ${slots.slice(0, 3).map((s) => s.formatted).join(', ')}. Which time works for you?`;
    }

    // ── ADMISSIONS FLOW (Sherlin) ─────────────────────────────
    const gradeRe = /\b(?:class|grade|standard|std)?\s*([6-9]|10|11|12|1st|2nd|3rd|4th|5th|6th|7th|8th|9th|10th|11th|12th)\b/i;
    const boardRe = /\b(cbse|icse|state|igcse|ib)\b/i;

    if (lead.status === 'enquiry' && (!lead.gradeInterested || !lead.boardInterested)) {
      const gradeMatch = userText.match(gradeRe);
      const boardMatch = userText.match(boardRe);
      const data: Record<string, string> = {};
      if (gradeMatch) data.gradeInterested = `Class ${gradeMatch[1].replace(/(st|nd|rd|th)$/i, '')}`;
      if (boardMatch) data.boardInterested = boardMatch[1].toUpperCase();

      if (Object.keys(data).length > 0) {
        await prisma.lead.update({ where: { id: lead.id }, data });
      }
      const grade = data.gradeInterested || lead.gradeInterested;
      const board = data.boardInterested || lead.boardInterested;

      if (grade && board) {
        return `Hi, this is Sherlin from E-Kalavya.\n\nThank you for reaching out. We have strong teachers for ${grade} (${board}). Which subjects does your child need the most support in — Maths, Science, or something else?`;
      }
      if (grade) {
        return `Hi, this is Sherlin from E-Kalavya.\n\n${grade} is an important year. Which board is your child following — CBSE, ICSE, or State Board?`;
      }
      if (board) {
        return `Got it, ${board}.\n\nAnd which class or grade is your child in right now?`;
      }
      return `Hi, this is Sherlin from E-Kalavya.\n\nThank you for reaching out. Could you tell me your child's class and board? For example, 10th CBSE or 12th State Board.`;
    }

    if (lead.status === 'enquiry' || lead.status === 'qualified') {
      // Booking only once the lead is qualified (details captured, slots offered)
      const isAgreeingToDemo =
        lead.status === 'qualified' &&
        (/\b(yes|yeah|ok|okay|book|sure|demo|tomorrow|confirm)\b/i.test(textLower) ||
          /\b\d{1,2}(:\d{2})?\s*(am|pm)\b/i.test(textLower));

      if (isAgreeingToDemo) {
        let slots: Array<{ time: string; iso: string; formatted: string }> = [];
        try {
          slots = (await tool('AdmissionsAI', 'check_calendar', {})).availableSlots;
        } catch {
          return `Let me check the calendar with my colleague Aryan and get back to you with demo timings shortly.`;
        }
        if (slots.length === 0) {
          return `We're fully booked on the next available day. Let me check other days and get back to you.`;
        }
        const selected = pickSlot(userText, slots) ?? slots[0];

        // Admissions cannot book: hand off, then the coordinator books.
        try {
          await tool('AdmissionsAI', 'handoff_to_demo_coordinator', { leadId: lead.id, preferredSlot: selected.iso });
          await tool('DemoCoordinatorAI', 'book_demo', { leadId: lead.id, scheduledAt: selected.iso, durationMinutes: 30 });
        } catch (err) {
          logger.warn('Deterministic demo booking failed', { leadId: lead.id, err });
          return `Thank you. I'm confirming the ${selected.formatted} slot with my colleague Aryan and will message you shortly.`;
        }
        return `Your demo is booked for ${istDayLabel(new Date(selected.iso))} at ${selected.formatted}.\n\nMy colleague Aryan from our academic desk will send you the teacher details and the joining link a little before class. See you then.`;
      }

      const subjects: string[] = [];
      if (/math/i.test(textLower)) subjects.push('Mathematics');
      if (/science/i.test(textLower)) subjects.push('Science');
      if (/physic/i.test(textLower)) subjects.push('Physics');
      if (/chem/i.test(textLower)) subjects.push('Chemistry');
      if (/bio/i.test(textLower)) subjects.push('Biology');
      if (/english/i.test(textLower)) subjects.push('English');

      if (subjects.length > 0 && lead.gradeInterested && lead.boardInterested) {
        await tool('AdmissionsAI', 'qualify_lead', {
          leadId: lead.id,
          gradeInterested: lead.gradeInterested,
          boardInterested: lead.boardInterested,
          subjectsInterested: subjects,
          requirements: userText,
        });

        let slotText = '';
        try {
          const cal = await tool('AdmissionsAI', 'check_calendar', {});
          slotText = cal.availableSlots.slice(0, 3).map((s: any) => s.formatted).join(', ');
        } catch {
          /* offer the demo without times rather than inventing them */
        }
        return slotText
          ? `We have experienced senior teachers for ${subjects.join(', ')}.\n\nWould you like your child to join a free 30-minute 1-on-1 demo class? We have slots open tomorrow at ${slotText} — which one works best for you?`
          : `We have experienced senior teachers for ${subjects.join(', ')}.\n\nWould you like a free 30-minute 1-on-1 demo class for your child? I can share the open timings.`;
      }
    }

    return `Hi, this is Sherlin from E-Kalavya. How can I help you today with our coaching batches or demo classes?`;
  }

  // ── Real LLM with tool calling ───────────────────────────────

  private systemPrompt(agentId: string, lead: any, hint?: string): string {
    const persona =
      agentId === 'DemoCoordinatorAI'
        ? `You are Aryan, a friendly demo-class coordinator on the academic desk at E-Kalavya coaching institute, texting parents on WhatsApp. You schedule free 1-on-1 demo classes.`
        : `You are Sherlin, the Admissions Manager at E-Kalavya coaching institute, texting parents on WhatsApp.`;

    const toolRules =
      agentId === 'DemoCoordinatorAI'
        ? `- To book: call check_calendar, then book_demo with the iso value of the slot the parent chose. Only tell the parent the demo is booked if book_demo returned success; if it errored, say so and offer other slots.`
        : `- Use qualify_lead once you know class, board and at least one subject.
- You cannot book demos. When the parent wants a demo: call check_calendar, offer 2-3 slots, and once they choose call handoff_to_demo_coordinator (with preferredSlot). Never say a demo is booked yourself.
- If a tool says something is pending approval, do not mention internal approvals to the parent.`;

    const introSequence =
      agentId === 'AdmissionsAI'
        ? `
FIRST-CONTACT SEQUENCE (only when this is a brand-new conversation, no prior messages in the history below): ask these one at a time, in this exact order, waiting for a reply to each before moving to the next. Do not skip ahead or bundle them into one message.
1. Send a short, warm welcome message introducing yourself as Sherlin from E-Kalavya.
2. Ask their name.
3. Ask which city/place they're writing from.
4. Ask which language they'd prefer to continue in: Tamil, English, Hindi, Tanglish, or Hinglish. Once they answer, continue the ENTIRE rest of the conversation in that chosen style/language, regardless of what language they type in afterward (this takes priority over rule 5 below).
5. Ask whether they themselves are the parent or the student.
Only after all five of these are answered do you move into the normal qualification flow (class, board, subjects, requirement) described in the tool rules below. If the conversation history already shows some of these were answered, don't re-ask them — pick up at the next unanswered one.
`
        : '';

    return `${persona}

CONVERSATIONAL RULES:
1. You write like a real, warm, capable manager who genuinely wants to help the family — calm and confident, not bubbly or overeager.
2. NEVER sound like a corporate bot. NEVER use numbered lists, bullet points, or stiff corporate email jargon ("Dear Sir/Madam", "kindly find attached", "AI Assistant"). Also never use casual teenage chat-speak, excessive exclamation marks, or slang.
3. Keep responses short and conversational (1-2 sentences per thought), in complete sentences with normal capitalization. Use double line breaks (\\n\\n) between thoughts so the system sends them as natural separate chat bubbles.
4. Do not use emojis. If one genuinely fits the moment, use at most one in the whole message — never more, and never in most messages.
5. If the parent writes in Tamil or Hindi/Hinglish, reply naturally in the same language, in the same measured tone (unless they've already chosen a language preference per the first-contact sequence below, which takes priority).
6. Always ask ONE simple question at a time, and wait for their reply before asking the next — never bundle multiple questions into one message.
7. Never invent facts, prices, slots or outcomes. Use tools for anything factual; never quote fees (refer to the admin team).
8. Your final answer is the WhatsApp text to send to the parent.
${introSequence}Tool rules:
${toolRules}
Current time: ${istNow()} (IST). Lead ID: ${lead.id}. Parent: ${lead.parent?.fullName || 'Parent'}. Lead status: ${lead.status}.${hint ? `\n\n${hint}` : ''}`;
  }

  private async composeWithLlm(
    config: LlmConfig,
    agentId: string,
    lead: any,
    history: ChatMessage[]
  ): Promise<{ text: string; agentId: string }> {
    const first = await this.runToolLoop(config, agentId, lead, history);

    // AdmissionsAI cannot book. When it handed over in this turn, the coordinator finishes the job
    // in the same turn and its reply replaces the admissions reply.
    if (agentId === 'AdmissionsAI' && first.handoff) {
      const hint = `Admissions just handed this lead to you${first.handoff.preferredSlot ? ` with preferred slot ${first.handoff.preferredSlot}` : ''}${first.handoff.note ? ` (${first.handoff.note})` : ''}. Verify the slot with check_calendar, book it with book_demo, then reply with ONE short confirmation, only if booking succeeded.`;
      try {
        const second = await this.runToolLoop(config, 'DemoCoordinatorAI', lead, history, hint);
        return { text: second.text, agentId: 'DemoCoordinatorAI' };
      } catch (err) {
        logger.error('Demo coordinator hand-off turn failed', { err });
        await aiActivityLogService.log({
          agentId: 'DemoCoordinatorAI',
          targetId: lead.id,
          actionType: 'handoff_turn_failed',
          payload: { error: err instanceof Error ? err.message : String(err) },
          status: 'failure',
        });
      }
    }
    return { text: first.text, agentId };
  }

  /** One POST to the chat-completions endpoint; always records monitor + activity-log entries. */
  private async callCompletion(
    config: LlmConfig,
    agentId: string,
    leadId: string,
    iteration: number,
    messages: LlmMessage[],
    tools: unknown[] | undefined
  ): Promise<{ message: LlmMessage & { reasoning?: string }; usage?: LlmUsage }> {
    const started = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);
    const promptPreview = [...messages].reverse().find((m) => m.role === 'user')?.content || '';

    const fail = async (errorMessage: string): Promise<never> => {
      const latencyMs = Date.now() - started;
      llmMonitorService.recordCall({ provider: config.provider, model: config.model, agentId, status: 'error', latencyMs, promptPreview, errorMessage });
      await aiActivityLogService.log({
        agentId,
        targetId: leadId,
        actionType: 'llm_completion',
        payload: { provider: config.provider, model: config.model, latencyMs, iteration, error: errorMessage },
        status: 'failure',
      });
      throw new Error(errorMessage);
    };

    let response: globalThis.Response;
    try {
      response = await fetch(config.url, {
        method: 'POST',
        headers: config.headers,
        body: JSON.stringify({
          model: config.model,
          messages,
          ...(tools && tools.length > 0 ? { tools } : {}),
          temperature: 0.4,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      return fail(`${config.provider} request failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return fail(`${config.provider} returned HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    }

    let data: any;
    try {
      data = await response.json();
    } catch {
      return fail(`${config.provider} returned a non-JSON body`);
    }
    const message = data?.choices?.[0]?.message;
    if (!message) return fail(`${config.provider} response had no choices`);

    const latencyMs = Date.now() - started;
    const usage: LlmUsage | undefined = data.usage;
    const toolNames = (message.tool_calls ?? []).map((c: any) => c.function?.name);
    llmMonitorService.recordCall({
      provider: config.provider,
      model: config.model,
      agentId,
      status: 'success',
      latencyMs,
      promptTokens: usage?.prompt_tokens,
      completionTokens: usage?.completion_tokens,
      promptPreview,
      responsePreview: message.content || (toolNames.length ? `tool_calls: ${toolNames.join(', ')}` : ''),
    });
    await aiActivityLogService.log({
      agentId,
      targetId: leadId,
      actionType: 'llm_completion',
      payload: {
        provider: config.provider,
        model: config.model,
        latencyMs,
        iteration,
        promptTokens: usage?.prompt_tokens ?? null,
        completionTokens: usage?.completion_tokens ?? null,
        toolCalls: toolNames,
      },
      status: 'success',
    });
    return { message, usage };
  }

  /**
   * Tool-calling loop (OpenAI format): send tools, run returned tool_calls, feed role:'tool'
   * results back, repeat until the model answers with text. Tool errors go back to the model as
   * tool results. The last iteration omits tools so the model must answer in text.
   */
  private async runToolLoop(
    config: LlmConfig,
    agentId: string,
    lead: any,
    history: ChatMessage[],
    hint?: string
  ): Promise<LlmRunResult> {
    const tools = agentToolsService.getToolDefinitions(agentId).map((t) => ({ type: 'function', function: t }));
    const messages: LlmMessage[] = [
      { role: 'system', content: this.systemPrompt(agentId, lead, hint) },
      ...history.map((h) => ({ role: h.role, content: h.content }) as LlmMessage),
    ];
    let handoff: LlmRunResult['handoff'];

    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const isLast = i === MAX_TOOL_ITERATIONS - 1;
      const { message } = await this.callCompletion(config, agentId, lead.id, i + 1, messages, isLast ? undefined : tools);

      const calls = isLast ? [] : (message.tool_calls ?? []).slice(0, MAX_TOOL_CALLS_PER_ITERATION);
      if (calls.length === 0) {
        // Drop reasoning-model <think> blocks; never surface chain-of-thought to a parent.
        const text = (message.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        if (text) return { text, handoff };
        throw new Error('LLM returned no text answer');
      }

      messages.push({ role: 'assistant', content: message.content ?? null, tool_calls: calls });
      for (const call of calls) {
        const name = call.function?.name;
        let content: string;
        try {
          const args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
          const result = await agentToolsService.executeTool(agentId, name, args, { leadId: lead.id });
          if (name === 'handoff_to_demo_coordinator') {
            handoff = { preferredSlot: result.preferredSlot ?? undefined, note: result.note ?? undefined };
          }
          content = JSON.stringify(result, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
        } catch (err) {
          content = JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content });
      }
    }
    throw new Error('LLM tool loop ended without a text answer');
  }

  /**
   * Daily follow-up routine for inactive leads (Design_Doc.md §2)
   */
  async runDailyFollowup(): Promise<{ followedUpCount: number; skippedOptedOut: number; skippedRateLimited: number }> {
    logger.info('Starting AdmissionsAI daily follow-up routine...');

    // Find leads in 'enquiry' status untouched for more than 48 hours
    const twoDaysAgo = new Date(Date.now() - 48 * 3600 * 1000);
    const dayAgo = new Date(Date.now() - 24 * 3600 * 1000);
    const inactiveLeads = await prisma.lead.findMany({
      where: {
        status: 'enquiry',
        updatedAt: { lte: twoDaysAgo },
      },
      include: { parent: true },
      take: 20,
    });

    let count = 0;
    let skippedOptedOut = 0;
    let skippedRateLimited = 0;
    for (const lead of inactiveLeads) {
      if (!lead.parent?.whatsappNumber) continue;
      if (lead.parent.optedOut) {
        skippedOptedOut++;
        continue;
      }
      // Same guardrail as send_whatsapp_message: max 3 outbound AI messages per lead per 24h
      const sent24h = await prisma.message.count({
        where: { leadId: lead.id, direction: 'outbound', agentId: { not: null }, createdAt: { gte: dayAgo } },
      });
      if (sent24h >= 3) {
        skippedRateLimited++;
        continue;
      }

      const followUpMsg = `Hi ${lead.parent.fullName || 'there'}, this is Sherlin from E-Kalavya. I wanted to check if you had any questions about our coaching programs. We'd be happy to arrange a free demo session for your child whenever it suits you.`;

      const message = await prisma.message.create({
        data: {
          leadId: lead.id,
          parentId: lead.parentId,
          direction: 'outbound',
          channel: 'whatsapp',
          body: followUpMsg,
          status: 'queued',
          agentId: 'AdmissionsAI',
        },
      });
      try {
        await enqueueWhatsApp({
          to: lead.parent.whatsappNumber,
          text: followUpMsg,
          agentId: 'AdmissionsAI',
          targetId: lead.id,
          messageId: message.id,
        });
      } catch (err) {
        await prisma.message.update({ where: { id: message.id }, data: { status: 'failed:enqueue' } });
        await aiActivityLogService.log({
          agentId: 'AdmissionsAI',
          targetId: lead.id,
          actionType: 'daily_followup_sent',
          payload: { leadId: lead.id, error: err instanceof Error ? err.message : String(err) },
          status: 'failure',
        });
        continue;
      }

      await aiActivityLogService.log({
        agentId: 'AdmissionsAI',
        targetId: lead.id,
        actionType: 'daily_followup_sent',
        payload: { leadId: lead.id, to: lead.parent.whatsappNumber },
        status: 'success',
      });

      // Update lead touched timestamp
      await prisma.lead.update({
        where: { id: lead.id },
        data: { updatedAt: new Date() },
      });

      count++;
    }

    logger.info(`Completed AdmissionsAI daily follow-up routine. Followed up with ${count} leads.`);
    return { followedUpCount: count, skippedOptedOut, skippedRateLimited };
  }
}

export const hermesService = new HermesService();
