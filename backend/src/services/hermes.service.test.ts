import { describe, it, expect, afterAll, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '../utils/database';
import { redis } from '../utils/redis';

vi.mock('../utils/queues', async (orig) => ({
  ...(await orig<typeof import('../utils/queues')>()),
  enqueueWhatsApp: vi.fn(async () => undefined),
}));

import { enqueueWhatsApp } from '../utils/queues';
import { hermesService, resolveLlmConfig } from './hermes.service';
import { llmMonitorService } from './llm-monitor.service';

const sfx = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const parentIds: string[] = [];
const leadIds: string[] = [];
const ENV_KEYS = ['LLM_PROVIDER', 'USE_REAL_LLM', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'OPENROUTER_MODEL', 'OLLAMA_BASE_URL', 'OLLAMA_MODEL'];
const savedEnv: Record<string, string | undefined> = {};

async function mkLead(status: 'enquiry' | 'qualified' = 'qualified', optedOut = false) {
  const p = await prisma.parent.create({
    data: { fullName: `HermesTest ${sfx}`, whatsappNumber: `6${sfx}${parentIds.length}`.slice(0, 20), optedOut },
  });
  parentIds.push(p.id);
  const l = await prisma.lead.create({
    data: { parentId: p.id, status, gradeInterested: 'Class 10', boardInterested: 'CBSE', subjectsInterested: ['Maths'] },
  });
  leadIds.push(l.id);
  return { parent: p, lead: l };
}

const toolCallMsg = (calls: Array<{ id: string; name: string; args: unknown }>) => ({
  choices: [{ message: { role: 'assistant', content: null, tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) } }],
  usage: { prompt_tokens: 11, completion_tokens: 3 },
});
const textMsg = (content: string) => ({ choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 20, completion_tokens: 5 } });
const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

beforeAll(() => {
  ENV_KEYS.forEach((k) => (savedEnv[k] = process.env[k]));
});

beforeEach(() => {
  ENV_KEYS.forEach((k) => delete process.env[k]);
  vi.mocked(enqueueWhatsApp).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  ENV_KEYS.forEach((k) => (savedEnv[k] === undefined ? delete process.env[k] : (process.env[k] = savedEnv[k])));
});

afterAll(async () => {
  await prisma.aiActivityLog.deleteMany({ where: { targetId: { in: leadIds } } });
  await prisma.message.deleteMany({ where: { leadId: { in: leadIds } } });
  await prisma.appointment.deleteMany({ where: { leadId: { in: leadIds } } });
  await prisma.lead.deleteMany({ where: { id: { in: leadIds } } });
  await prisma.parent.deleteMany({ where: { id: { in: parentIds } } });
  await Promise.all(leadIds.map((id) => redis.del(`ekalavya:chat:lead:${id}`)));
});

describe('resolveLlmConfig', () => {
  it('reaches openrouter (no outer gate) and reads env at call time', () => {
    process.env.LLM_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'k1';
    process.env.OPENROUTER_MODEL = 'm/x';
    const { config } = resolveLlmConfig('AdmissionsAI');
    expect(config?.provider).toBe('openrouter');
    expect(config?.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(config?.model).toBe('m/x');
    expect(config?.headers.Authorization).toBe('Bearer k1');
    process.env.OPENROUTER_MODEL = 'm/y';
    expect(resolveLlmConfig('AdmissionsAI').config?.model).toBe('m/y');
  });

  it('picks the customer-facing vs backend OpenRouter model by agent when OPENROUTER_MODEL is unset', () => {
    process.env.LLM_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'k1';
    delete process.env.OPENROUTER_MODEL;
    process.env.OPENROUTER_MODEL_CUSTOMER_FACING = 'qwen/qwen3.8-flash';
    process.env.OPENROUTER_MODEL_BACKEND = 'z-ai/glm-5.3-flash';
    expect(resolveLlmConfig('AdmissionsAI').config?.model).toBe('qwen/qwen3.8-flash');
    expect(resolveLlmConfig('DemoCoordinatorAI').config?.model).toBe('qwen/qwen3.8-flash');
    expect(resolveLlmConfig('ChiefOfStaffAI').config?.model).toBe('z-ai/glm-5.3-flash');
    delete process.env.OPENROUTER_MODEL_CUSTOMER_FACING;
    delete process.env.OPENROUTER_MODEL_BACKEND;
  });

  it('supports ollama by default and openai with a key', () => {
    expect(resolveLlmConfig('AdmissionsAI').config?.provider).toBe('ollama');
    process.env.LLM_PROVIDER = 'openai';
    expect(resolveLlmConfig('AdmissionsAI').deterministicReason).toMatch(/OPENAI_API_KEY/);
    process.env.OPENAI_API_KEY = 'sk';
    expect(resolveLlmConfig('AdmissionsAI').config?.url).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('USE_REAL_LLM=false and LLM_PROVIDER=deterministic force the rule engine', () => {
    process.env.USE_REAL_LLM = 'false';
    expect(resolveLlmConfig('AdmissionsAI').config).toBeUndefined();
    delete process.env.USE_REAL_LLM;
    process.env.LLM_PROVIDER = 'deterministic';
    expect(resolveLlmConfig('AdmissionsAI').config).toBeUndefined();
    process.env.LLM_PROVIDER = 'bogus';
    expect(resolveLlmConfig('AdmissionsAI').deterministicReason).toMatch(/Unknown/);
  });
});

describe('LLM tool-calling loop', () => {
  it('executes tool calls, feeds role:tool results back with tool_call_id, returns the final text and logs everything', async () => {
    process.env.LLM_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'k';
    const { lead, parent } = await mkLead('enquiry');
    const bodies: any[] = [];
    const responses = [
      toolCallMsg([
        { id: 'c1', name: 'qualify_lead', args: { leadId: lead.id, gradeInterested: 'Class 10', boardInterested: 'CBSE', subjectsInterested: ['Maths'], aiScore: 80 } },
        { id: 'c2', name: 'book_demo', args: { leadId: lead.id, scheduledAt: new Date(Date.now() + 86400000).toISOString() } }, // not allowed for Admissions
      ]),
      textMsg('great, qualified you! which slot works?'),
    ];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      return okJson(responses[bodies.length - 1]);
    }));
    const before = llmMonitorService.getMetrics().totalRequests;

    const reply = await hermesService.handleInboundMessage({ fromNumber: parent.whatsappNumber, textContent: '10th CBSE maths', parentId: parent.id, leadId: lead.id });

    expect(reply).toBe('great, qualified you! which slot works?');
    expect(bodies).toHaveLength(2);
    expect(bodies[0].tools.map((t: any) => t.function.name)).not.toContain('book_demo');
    const toolMsgs = bodies[1].messages.filter((m: any) => m.role === 'tool');
    expect(toolMsgs.map((m: any) => m.tool_call_id)).toEqual(['c1', 'c2']);
    expect(JSON.parse(toolMsgs[1].content).error).toMatch(/Permission denied/); // error returned to model, not thrown
    expect((await prisma.lead.findUnique({ where: { id: lead.id } }))!.aiScore).toBe(80);

    expect(llmMonitorService.getMetrics().totalRequests).toBe(before + 2);
    const llmRows = await prisma.aiActivityLog.findMany({ where: { targetId: lead.id, actionType: 'llm_completion' } });
    expect(llmRows).toHaveLength(2);
    expect((llmRows[0].payload as any).provider).toBe('openrouter');
    expect((llmRows[0].payload as any).latencyMs).toBeTypeOf('number');
    expect(await prisma.message.count({ where: { leadId: lead.id, direction: 'outbound', agentId: 'AdmissionsAI' } })).toBe(1);
    expect(enqueueWhatsApp).toHaveBeenCalledWith(expect.objectContaining({ to: parent.whatsappNumber, text: reply }));
  });

  it('forces a text answer on the last iteration and never returns the old placeholder', async () => {
    process.env.LLM_PROVIDER = 'ollama';
    const { lead, parent } = await mkLead('enquiry');
    let calls = 0;
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: any) => {
      const b = JSON.parse(init.body);
      bodies.push(b);
      calls++;
      return okJson(b.tools ? toolCallMsg([{ id: `c${calls}`, name: 'get_lead', args: { leadId: lead.id } }]) : textMsg('final answer'));
    }));
    const reply = await hermesService.handleInboundMessage({ fromNumber: parent.whatsappNumber, textContent: 'hi', parentId: parent.id, leadId: lead.id });
    expect(reply).toBe('final answer');
    expect(calls).toBe(4);
    expect(bodies[3].tools).toBeUndefined();
    expect(reply).not.toMatch(/Thank you for reaching out/);
  });

  it('a handoff in the admissions turn lets the coordinator book, and only then claims success', async () => {
    process.env.LLM_PROVIDER = 'ollama';
    const { lead, parent } = await mkLead('qualified');
    const slotIso = new Date(Date.now() + 2 * 86400000);
    slotIso.setUTCHours(10, 0, 0, 0);
    slotIso.setUTCMinutes(Math.floor(Math.random() * 59)); // unlikely to clash with seeded slots
    const iso = slotIso.toISOString();
    const queue = [
      toolCallMsg([{ id: 'h1', name: 'handoff_to_demo_coordinator', args: { leadId: lead.id, preferredSlot: iso } }]),
      textMsg('admissions text (discarded)'),
      toolCallMsg([{ id: 'b1', name: 'book_demo', args: { leadId: lead.id, scheduledAt: iso } }]),
      textMsg('Your demo is booked!'),
    ];
    let i = 0;
    vi.stubGlobal('fetch', vi.fn(async () => okJson(queue[i++])));
    const reply = await hermesService.handleInboundMessage({ fromNumber: parent.whatsappNumber, textContent: 'yes that slot', parentId: parent.id, leadId: lead.id });
    expect(reply).toBe('Your demo is booked!');
    expect((await prisma.lead.findUnique({ where: { id: lead.id } }))!.status).toBe('demo_scheduled');
    expect(await prisma.message.count({ where: { leadId: lead.id, agentId: 'DemoCoordinatorAI' } })).toBe(1);
  });
});

describe('deterministic fallback', () => {
  it('is labelled in the activity log, and a failed LLM call falls back honestly', async () => {
    process.env.LLM_PROVIDER = 'ollama';
    const { lead, parent } = await mkLead('enquiry');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, text: async () => 'down', json: async () => ({}) })));
    const reply = await hermesService.handleInboundMessage({ fromNumber: parent.whatsappNumber, textContent: 'hello', parentId: parent.id, leadId: lead.id });
    expect(reply).toBeTruthy();
    const row = await prisma.aiActivityLog.findFirst({ where: { targetId: lead.id, actionType: 'reply_deterministic' } });
    expect((row!.payload as any).reason).toMatch(/LLM failed.*503/);
    const failed = await prisma.aiActivityLog.findFirst({ where: { targetId: lead.id, actionType: 'llm_completion', status: 'failure' } });
    expect(failed).toBeTruthy();
  });

  it('books via handoff + coordinator and labels every tool row _deterministic', async () => {
    process.env.USE_REAL_LLM = 'false';
    const { lead, parent } = await mkLead('qualified');
    const reply = await hermesService.handleInboundMessage({ fromNumber: parent.whatsappNumber, textContent: 'yes please book the demo', parentId: parent.id, leadId: lead.id });
    const rows = await prisma.aiActivityLog.findMany({ where: { targetId: lead.id } });
    const booked = (await prisma.lead.findUnique({ where: { id: lead.id } }))!.status === 'demo_scheduled';
    if (booked) {
      expect(reply).toMatch(/booked/i);
      expect(rows.some((r) => r.actionType === 'tool_book_demo_deterministic' && r.status === 'success')).toBe(true);
    } else {
      expect(reply).not.toMatch(/booked for/i);
    }
    expect(rows.filter((r) => r.actionType?.startsWith('tool_')).every((r) => r.actionType?.endsWith('_deterministic'))).toBe(true);
    expect(rows.some((r) => r.actionType === 'reply_deterministic')).toBe(true);
  });

  it('does not claim a booking when the tool fails', async () => {
    process.env.USE_REAL_LLM = 'false';
    const { lead, parent } = await mkLead('qualified');
    const { agentToolsService } = await import('./agent-tools.service');
    const original = agentToolsService.executeTool.bind(agentToolsService);
    const spy = vi.spyOn(agentToolsService, 'executeTool').mockImplementation(async (agent, tool, args, ctx) => {
      if (tool === 'book_demo') throw new Error('slot taken');
      return original(agent, tool, args, ctx);
    });
    try {
      const reply = await hermesService.handleInboundMessage({ fromNumber: parent.whatsappNumber, textContent: 'yes book it', parentId: parent.id, leadId: lead.id });
      expect(reply).not.toMatch(/booked|all set/i);
      expect(reply).toMatch(/confirming/i);
      expect((await prisma.lead.findUnique({ where: { id: lead.id } }))!.status).not.toBe('demo_scheduled');
    } finally {
      spy.mockRestore();
    }
  });

  it('does not reply to opted-out parents', async () => {
    process.env.USE_REAL_LLM = 'false';
    const { lead, parent } = await mkLead('enquiry', true);
    const reply = await hermesService.handleInboundMessage({ fromNumber: parent.whatsappNumber, textContent: 'hi', parentId: parent.id, leadId: lead.id });
    expect(reply).toBe('');
    expect(enqueueWhatsApp).not.toHaveBeenCalled();
  });
});
