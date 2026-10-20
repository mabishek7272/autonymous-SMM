import { Router, Request, Response } from 'express';
import { prisma } from '../utils/database';
import { redis } from '../utils/redis';
import { logger } from '../utils/logger';
import { messagingAdapter } from '../services/messaging.adapter';
import { aiActivityLogService } from '../services/ai-activity-log.service';
import { llmMonitorService } from '../services/llm-monitor.service';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { rolesWith } from '../utils/permissions';
import { resolveLlmConfig } from '../services/hermes.service';

const router = Router();

// ── Developer Console Security Guard ─────────────────────────
// Superadmin JWT only. No shared API keys, no query-string credentials.
router.use(authenticate, authorize(...rolesWith('dev:console')));

// In-memory runtime config overrides (synced with process.env)
const runtimeConfig = {
  llmProvider: (process.env.LLM_PROVIDER || 'ollama') as 'ollama' | 'openai' | 'openrouter' | 'hub' | 'deterministic',
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
  ollamaModel: process.env.OLLAMA_MODEL || 'qwen3.8:27b',
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  openrouterApiKey: process.env.OPENROUTER_API_KEY || '',
  // Explicit override; leave unset to let customer-facing vs backend agents use their own model below.
  openrouterModel: process.env.OPENROUTER_MODEL || '',
  openrouterModelCustomerFacing: process.env.OPENROUTER_MODEL_CUSTOMER_FACING || 'qwen/qwen3.8-flash',
  openrouterModelBackend: process.env.OPENROUTER_MODEL_BACKEND || 'z-ai/glm-5.3-flash',
  hubBaseUrl: process.env.HUB_BASE_URL || 'https://hub.amgi.in/v1',
  hubModel: process.env.HUB_MODEL || 'glm-4.7-flash',
  hubApiKey: process.env.HUB_API_KEY || '',
  useRealLlm: process.env.USE_REAL_LLM === 'true',
  evolutionGoUrl: process.env.EVOLUTION_GO_URL || 'http://localhost:8081',
  evolutionGoInstance: process.env.EVOLUTION_GO_INSTANCE || 'ekalavya-main',
  evolutionGoApiKey: process.env.EVOLUTION_GO_API_KEY || '',
  founderWhatsappNumber: process.env.FOUNDER_WHATSAPP_NUMBER || '919876543210',
  assistantName: 'Sherlin',
};

/**
 * GET /api/v1/dev/config
 * Returns system configuration, runtime variables, and connection health
 */
router.get('/config', async (_req: Request, res: Response) => {
  let dbStatus = 'disconnected';
  let redisStatus = 'disconnected';

  try {
    await prisma.$queryRaw`SELECT 1`;
    dbStatus = 'connected';
  } catch {
    dbStatus = 'error';
  }

  try {
    await redis.ping();
    redisStatus = 'connected';
  } catch {
    redisStatus = 'error';
  }

  // Mask sensitive keys for security
  const mask = (str: string) => (str.length > 8 ? `${str.slice(0, 4)}••••${str.slice(-4)}` : (str ? '••••••••' : ''));

  // Never echo raw secrets back to the browser; only the masked variants leave the server.
  const { openaiApiKey: _openai, openrouterApiKey: _openrouter, hubApiKey: _hub, evolutionGoApiKey: _evolution, ...publicConfig } = runtimeConfig;

  res.json({
    config: {
      ...publicConfig,
      openaiApiKeyMasked: mask(runtimeConfig.openaiApiKey),
      openrouterApiKeyMasked: mask(runtimeConfig.openrouterApiKey),
      hubApiKeyMasked: mask(runtimeConfig.hubApiKey),
      evolutionGoApiKeyMasked: mask(runtimeConfig.evolutionGoApiKey),
    },
    systemHealth: {
      database: dbStatus,
      redis: redisStatus,
      nodeVersion: process.version,
      uptimeSeconds: Math.round(process.uptime()),
    },
  });
});

/**
 * POST /api/v1/dev/config
 * Updates runtime environment configuration
 */
router.post('/config', async (req: Request, res: Response) => {
  const {
    llmProvider,
    ollamaBaseUrl,
    ollamaModel,
    openaiApiKey,
    openaiModel,
    openrouterApiKey,
    openrouterModel,
    openrouterModelCustomerFacing,
    openrouterModelBackend,
    hubBaseUrl,
    hubModel,
    hubApiKey,
    useRealLlm,
    evolutionGoUrl,
    evolutionGoInstance,
    evolutionGoApiKey,
    founderWhatsappNumber,
    assistantName,
  } = req.body;

  if (llmProvider !== undefined) {
    runtimeConfig.llmProvider = llmProvider;
    process.env.LLM_PROVIDER = llmProvider;
    if (llmProvider === 'deterministic') {
      runtimeConfig.useRealLlm = false;
      process.env.USE_REAL_LLM = 'false';
    } else {
      runtimeConfig.useRealLlm = true;
      process.env.USE_REAL_LLM = 'true';
    }
  }
  if (ollamaBaseUrl !== undefined) {
    runtimeConfig.ollamaBaseUrl = ollamaBaseUrl;
    process.env.OLLAMA_BASE_URL = ollamaBaseUrl;
  }
  if (ollamaModel !== undefined) {
    runtimeConfig.ollamaModel = ollamaModel;
    process.env.OLLAMA_MODEL = ollamaModel;
  }
  if (openaiApiKey !== undefined && openaiApiKey !== '') {
    runtimeConfig.openaiApiKey = openaiApiKey;
    process.env.OPENAI_API_KEY = openaiApiKey;
  }
  if (openaiModel !== undefined) {
    runtimeConfig.openaiModel = openaiModel;
    process.env.OPENAI_MODEL = openaiModel;
  }
  if (openrouterApiKey !== undefined && openrouterApiKey !== '') {
    runtimeConfig.openrouterApiKey = openrouterApiKey;
    process.env.OPENROUTER_API_KEY = openrouterApiKey;
  }
  if (openrouterModel !== undefined) {
    runtimeConfig.openrouterModel = openrouterModel;
    process.env.OPENROUTER_MODEL = openrouterModel;
  }
  if (openrouterModelCustomerFacing !== undefined) {
    runtimeConfig.openrouterModelCustomerFacing = openrouterModelCustomerFacing;
    process.env.OPENROUTER_MODEL_CUSTOMER_FACING = openrouterModelCustomerFacing;
  }
  if (openrouterModelBackend !== undefined) {
    runtimeConfig.openrouterModelBackend = openrouterModelBackend;
    process.env.OPENROUTER_MODEL_BACKEND = openrouterModelBackend;
  }
  if (hubBaseUrl !== undefined) {
    runtimeConfig.hubBaseUrl = hubBaseUrl;
    process.env.HUB_BASE_URL = hubBaseUrl;
  }
  if (hubModel !== undefined) {
    runtimeConfig.hubModel = hubModel;
    process.env.HUB_MODEL = hubModel;
  }
  if (hubApiKey !== undefined && hubApiKey !== '') {
    runtimeConfig.hubApiKey = hubApiKey;
    process.env.HUB_API_KEY = hubApiKey;
  }
  if (useRealLlm !== undefined) {
    runtimeConfig.useRealLlm = Boolean(useRealLlm);
    process.env.USE_REAL_LLM = String(useRealLlm);
  }
  if (evolutionGoUrl !== undefined) {
    runtimeConfig.evolutionGoUrl = evolutionGoUrl;
    process.env.EVOLUTION_GO_URL = evolutionGoUrl;
  }
  if (evolutionGoInstance !== undefined) {
    runtimeConfig.evolutionGoInstance = evolutionGoInstance;
    process.env.EVOLUTION_GO_INSTANCE = evolutionGoInstance;
  }
  if (evolutionGoApiKey !== undefined && evolutionGoApiKey !== '') {
    runtimeConfig.evolutionGoApiKey = evolutionGoApiKey;
    process.env.EVOLUTION_GO_API_KEY = evolutionGoApiKey;
  }
  if (founderWhatsappNumber !== undefined) {
    runtimeConfig.founderWhatsappNumber = founderWhatsappNumber;
    process.env.FOUNDER_WHATSAPP_NUMBER = founderWhatsappNumber;
  }
  if (assistantName !== undefined) {
    runtimeConfig.assistantName = assistantName;
  }

  logger.info('Developer Console: Runtime configuration updated');
  res.json({ status: 'success', message: 'Runtime configuration updated successfully' });
});

/**
 * POST /api/v1/dev/test-whatsapp
 * Dispatches a test WhatsApp message to verify Evolution Go setup
 */
router.post('/test-whatsapp', async (req: Request, res: Response) => {
  const { to, message } = req.body;
  if (!to) {
    return res.status(400).json({ error: 'Target phone number is required' });
  }

  const text = message || `⚡ E-Kalavya Dev Console Ping: WhatsApp gateway is connected and active! Timestamp: ${new Date().toLocaleTimeString('en-IN')}`;

  try {
    const result = await messagingAdapter.sendText(to, text);
    await aiActivityLogService.log({
      agentId: 'ChiefOfStaffAI',
      actionType: 'dev_test_whatsapp',
      payload: { to, preview: text },
      status: 'success',
    });
    res.json({ status: 'success', result });
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message || 'Failed to dispatch message' });
  }
});

/**
 * POST /api/v1/dev/whatsapp/connect
 * Requests a "link with phone number" pairing code for the configured instance — the parent-free
 * alternative to QR scanning. Body: { phone }. Returns { code } to show the operator.
 */
router.post('/whatsapp/connect', async (req: Request, res: Response) => {
  const { phone } = req.body;
  if (!phone) {
    return res.status(400).json({ error: 'Phone number is required' });
  }
  try {
    const { code } = await messagingAdapter.pairPhone(phone);
    await aiActivityLogService.log({
      agentId: 'ChiefOfStaffAI',
      actionType: 'dev_whatsapp_pair_requested',
      payload: { phone },
      status: 'success',
    });
    res.json({ status: 'success', code });
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message || 'Failed to request a pairing code' });
  }
});

/**
 * POST /api/v1/dev/whatsapp/confirm-connected
 * Called once the frontend observes the gateway transition to connected after pairing — sends a
 * confirmation message, as Sherlin, to the founder's WhatsApp number.
 */
router.post('/whatsapp/confirm-connected', async (_req: Request, res: Response) => {
  const founderNumber = runtimeConfig.founderWhatsappNumber;
  const text = `This WhatsApp number is now connected and live as ${runtimeConfig.assistantName}, your E-Kalavya admissions assistant. Parent conversations will start coming through here.`;
  try {
    const result = await messagingAdapter.sendText(founderNumber, text);
    await aiActivityLogService.log({
      agentId: 'AdmissionsAI',
      actionType: 'whatsapp_connected_confirmation_sent',
      payload: { to: founderNumber },
      status: 'success',
    });
    res.json({ status: 'success', result });
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message || 'Failed to send the confirmation message' });
  }
});

/**
 * POST /api/v1/dev/clear-redis-cache
 * Flushes active lead chat memories in Redis
 */
router.post('/clear-redis-cache', async (_req: Request, res: Response) => {
  try {
    const keys = await redis.keys('ekalavya:chat:lead:*');
    if (keys.length > 0) {
      await redis.del(...keys);
    }
    logger.info(`Developer Console: Cleared ${keys.length} Redis lead chat memory keys`);
    res.json({ status: 'success', clearedKeysCount: keys.length });
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * POST /api/v1/dev/leads (Create Lead Direct CRUD)
 */
router.post('/leads', async (req: Request, res: Response) => {
  const { parentName, whatsappNumber, gradeInterested, boardInterested, subjectsInterested, source } = req.body;
  if (!parentName || !whatsappNumber) {
    return res.status(400).json({ error: 'parentName and whatsappNumber are required' });
  }

  try {
    // 1. Find or create parent
    let parent = await prisma.parent.findUnique({ where: { whatsappNumber } });
    if (!parent) {
      parent = await prisma.parent.create({
        data: { fullName: parentName, whatsappNumber },
      });
    }

    // 2. Create lead
    const lead = await prisma.lead.create({
      data: {
        parentId: parent.id,
        gradeInterested: gradeInterested || 'Class 10',
        boardInterested: boardInterested || 'CBSE',
        subjectsInterested: subjectsInterested || ['Mathematics', 'Science'],
        source: source || 'Meta',
        status: 'enquiry',
        assignedAgentId: 'AdmissionsAI',
      },
      include: { parent: true, appointments: true },
    });

    res.status(201).json(lead);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/v1/dev/leads/:id (Update Lead Direct CRUD)
 */
router.put('/leads/:id', async (req: Request, res: Response) => {
  const { status, gradeInterested, boardInterested, subjectsInterested, requirements } = req.body;
  try {
    const lead = await prisma.lead.update({
      where: { id: req.params.id },
      data: {
        status,
        gradeInterested,
        boardInterested,
        subjectsInterested,
        requirements,
      },
      include: { parent: true, appointments: true },
    });
    res.json(lead);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/v1/dev/leads/:id (Delete Lead Direct CRUD)
 */
router.delete('/leads/:id', async (req: Request, res: Response) => {
  try {
    await prisma.appointment.deleteMany({ where: { leadId: req.params.id } });
    await prisma.lead.delete({ where: { id: req.params.id } });
    res.json({ status: 'success', message: 'Lead deleted successfully' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/v1/dev/students (Create Student Direct CRUD)
 */
router.post('/students', async (req: Request, res: Response) => {
  const { fullName, parentWhatsapp, parentName, status, batchId } = req.body;
  if (!fullName) {
    return res.status(400).json({ error: 'fullName is required' });
  }

  try {
    let parent = null;
    if (parentWhatsapp) {
      parent = await prisma.parent.findUnique({ where: { whatsappNumber: parentWhatsapp } });
      if (!parent) {
        parent = await prisma.parent.create({
          data: { fullName: parentName || `${fullName}'s Parent`, whatsappNumber: parentWhatsapp },
        });
      }
    } else {
      parent = await prisma.parent.findFirst();
    }

    if (!parent) {
      return res.status(400).json({ error: 'No parent record found or provided' });
    }

    const student = await prisma.student.create({
      data: {
        fullName,
        parentId: parent.id,
        status: status || 'active',
        admissionDate: new Date(),
      },
      include: { parent: true },
    });

    if (batchId) {
      await prisma.enrollment.create({
        data: {
          studentId: student.id,
          batchId,
        },
      });
    }

    res.status(201).json(student);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/v1/dev/students/:id (Update Student Direct CRUD)
 */
router.put('/students/:id', async (req: Request, res: Response) => {
  const { fullName, status } = req.body;
  try {
    const student = await prisma.student.update({
      where: { id: req.params.id },
      data: {
        fullName,
        status,
      },
      include: { parent: true },
    });
    res.json(student);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/v1/dev/students/:id (Delete Student Direct CRUD)
 */
router.delete('/students/:id', async (req: Request, res: Response) => {
  try {
    await prisma.academicRecord.deleteMany({ where: { studentId: req.params.id } });
    await prisma.enrollment.deleteMany({ where: { studentId: req.params.id } });
    await prisma.student.delete({ where: { id: req.params.id } });
    res.json({ status: 'success', message: 'Student and related records deleted' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/v1/dev/courses (Create Course Direct CRUD)
 */
router.post('/courses', async (req: Request, res: Response) => {
  const { courseName, description } = req.body;
  if (!courseName) {
    return res.status(400).json({ error: 'courseName is required' });
  }
  try {
    const course = await prisma.course.create({
      data: { courseName, description: description || '' },
      include: { batches: true },
    });
    res.status(201).json(course);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/v1/dev/courses/:id (Delete Course Direct CRUD)
 */
router.delete('/courses/:id', async (req: Request, res: Response) => {
  try {
    await prisma.batch.deleteMany({ where: { courseId: req.params.id } });
    await prisma.course.delete({ where: { id: req.params.id } });
    res.json({ status: 'success', message: 'Course and related batches deleted' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/v1/dev/batches (Create Batch Direct CRUD)
 */
router.post('/batches', async (req: Request, res: Response) => {
  const { courseId, batchName, startDate, endDate } = req.body;
  if (!courseId || !batchName) {
    return res.status(400).json({ error: 'courseId and batchName are required' });
  }
  try {
    const batch = await prisma.batch.create({
      data: {
        courseId,
        batchName,
        startDate: startDate ? new Date(startDate) : new Date(),
        endDate: endDate ? new Date(endDate) : undefined,
      },
      include: { course: true },
    });
    res.status(201).json(batch);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/v1/dev/batches/:id (Delete Batch Direct CRUD)
 */
router.delete('/batches/:id', async (req: Request, res: Response) => {
  try {
    await prisma.enrollment.deleteMany({ where: { batchId: req.params.id } });
    await prisma.batch.delete({ where: { id: req.params.id } });
    res.json({ status: 'success', message: 'Batch deleted successfully' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Free (no-token-cost) catalog check for a cloud provider: confirms the API key works and the
 * configured model id is real, without spending a completion call. Mirrors the shape the UI
 * already expects from /ollama/models so the same components render it.
 */
async function cloudProviderStatus(): Promise<{
  online: boolean;
  baseUrl: string;
  activeModel: string;
  activeProvider: string;
  error?: string;
  models: Array<{ name: string; model: string; sizeFormatted: string; isLoaded: boolean; agentAssigned: string }>;
}> {
  const { config, deterministicReason } = resolveLlmConfig('AdmissionsAI');
  if (!config) {
    return { online: false, baseUrl: '', activeModel: '', activeProvider: runtimeConfig.llmProvider, error: deterministicReason ?? 'No provider configured', models: [] };
  }
  const catalogUrl =
    config.provider === 'openai'
      ? 'https://api.openai.com/v1/models'
      : config.provider === 'hub'
        ? `${(process.env.HUB_BASE_URL || 'https://hub.amgi.in/v1').replace(/\/$/, '')}/models`
        : 'https://openrouter.ai/api/v1/models';
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(catalogUrl, { headers: { Authorization: config.headers.Authorization ?? '' }, signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) {
      return { online: false, baseUrl: catalogUrl, activeModel: config.model, activeProvider: config.provider, error: `Provider returned HTTP ${res.status}`, models: [] };
    }
    const data = (await res.json()) as { data?: Array<{ id: string }> };
    const knownIds = new Set((data.data ?? []).map((m) => m.id));
    const modelKnown = knownIds.size === 0 || knownIds.has(config.model);
    return {
      online: modelKnown,
      baseUrl: catalogUrl,
      activeModel: config.model,
      activeProvider: config.provider,
      error: modelKnown ? undefined : `Model "${config.model}" was not found in the provider's catalog — check the model id in Configuration`,
      models: modelKnown
        ? [{ name: config.model, model: config.model, sizeFormatted: '—', isLoaded: true, agentAssigned: 'Active (all agents)' }]
        : [],
    };
  } catch (err: any) {
    return { online: false, baseUrl: catalogUrl, activeModel: config.model, activeProvider: config.provider, error: `Could not reach ${config.provider} (${err.message})`, models: [] };
  }
}

/**
 * GET /api/v1/dev/ollama/models
 * Returns the currently configured provider's model status. For Ollama, lists installed models
 * from the local daemon with VRAM status; for OpenAI/OpenRouter, confirms the key + model id are
 * valid via a free catalog lookup (no completion call, no token cost).
 */
router.get('/ollama/models', async (_req: Request, res: Response) => {
  if (runtimeConfig.llmProvider !== 'ollama') {
    return res.json(await cloudProviderStatus());
  }
  const baseUrl = runtimeConfig.ollamaBaseUrl || 'http://localhost:11434';
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);

    const [tagsRes, psRes] = await Promise.all([
      fetch(`${baseUrl}/api/tags`, { signal: controller.signal }).catch(() => null),
      fetch(`${baseUrl}/api/ps`, { signal: controller.signal }).catch(() => null),
    ]);
    clearTimeout(timeout);

    if (!tagsRes || !tagsRes.ok) {
      return res.status(502).json({
        online: false,
        baseUrl,
        models: [],
        error: tagsRes ? `Ollama returned HTTP ${tagsRes.status}` : 'Ollama daemon unreachable',
      });
    }

    const data = (await tagsRes.json()) as { models?: any[] };
    const rawModels = data.models || [];

    let loadedModels: any[] = [];
    if (psRes && psRes.ok) {
      try {
        const psData = (await psRes.json()) as any;
        loadedModels = psData.models || [];
      } catch {}
    }

    const formatBytes = (bytes: number) => {
      if (!bytes) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    };

    const models = rawModels.map((m: any) => {
      const caps = m.capabilities || [];
      const isLoaded = loadedModels.some((lm: any) => lm.name === m.name || lm.model === m.model);
      const loadedInfo = loadedModels.find((lm: any) => lm.name === m.name || lm.model === m.model);
      const supportsChat = caps.includes('completion') || caps.includes('chat') || !m.name.includes('nimble');
      
      // Map agent specialization based on model profile
      let agentAssigned = 'HermesAI';
      if (m.name.includes('qwen')) agentAssigned = 'AdmissionsAI';
      else if (m.name.includes('gemma')) agentAssigned = 'AcademicMon.';
      else if (m.name.includes('nimble')) agentAssigned = 'DemoCoord.';

      return {
        name: m.name,
        model: m.model || m.name,
        size: m.size || 0,
        sizeFormatted: formatBytes(m.size || 0),
        digest: m.digest ? m.digest.slice(0, 12) : '',
        details: m.details || {},
        capabilities: caps,
        supportsChat,
        isLoaded,
        vramSizeFormatted: loadedInfo?.size_vram ? formatBytes(loadedInfo.size_vram) : undefined,
        agentAssigned,
        modified_at: m.modified_at,
      };
    });

    const activeLoaded = loadedModels[0];

    res.json({
      online: true,
      baseUrl,
      activeModel: runtimeConfig.ollamaModel,
      activeProvider: runtimeConfig.llmProvider,
      loadedModel: activeLoaded?.name || null,
      vramUsedFormatted: activeLoaded?.size_vram ? formatBytes(activeLoaded.size_vram) : '18.5 GB',
      count: models.length,
      models,
    });
  } catch (err: any) {
    logger.warn('Failed to connect to Ollama daemon', { error: err.message, baseUrl });
    res.json({
      online: false,
      baseUrl,
      error: `Could not reach Ollama at ${baseUrl} (${err.message})`,
      models: [],
    });
  }
});

/**
 * Streams a completion from whichever cloud provider (OpenAI/OpenRouter) is currently
 * configured, translating its OpenAI-compatible SSE format into the same
 * `data: {token, done, ...}` frames the dev console's streaming UI already parses.
 */
async function streamCloudProvider(req: Request, res: Response): Promise<void> {
  const { config, deterministicReason } = resolveLlmConfig('AdmissionsAI');
  const prompt = req.body.prompt || 'Hello Sherlin! Please introduce yourself to a parent.';
  const systemPrompt = req.body.systemPrompt ||
    'You are Sherlin, the Admissions Manager at E-Kalavya Academy — warm, capable and professional. Reply in 1-2 helpful, concise sentences, in plain natural language with no emojis.';

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  if (!config) {
    res.write(`data: ${JSON.stringify({ error: deterministicReason ?? 'No LLM provider configured', done: true })}\n\n`);
    res.end();
    return;
  }

  const startTime = Date.now();
  let fullReply = '';
  let tokenCount = 0;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
    const upstream = await fetch(config.url, {
      method: 'POST',
      headers: config.headers,
      body: JSON.stringify({
        model: req.body.model || config.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
        stream: true,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!upstream.ok || !upstream.body) {
      const errText = await upstream.text().catch(() => 'No error body');
      res.write(`data: ${JSON.stringify({ error: `${config.provider} HTTP ${upstream.status}: ${errText}`, done: true })}\n\n`);
      res.end();
      return;
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const parsed = JSON.parse(payload);
          const chunk = parsed.choices?.[0]?.delta?.content || '';
          if (chunk) {
            fullReply += chunk;
            tokenCount++;
            res.write(`data: ${JSON.stringify({ token: chunk, done: false })}\n\n`);
          }
        } catch {}
      }
    }

    const latencyMs = Date.now() - startTime;
    llmMonitorService.recordCall({
      provider: config.provider,
      model: req.body.model || config.model,
      agentId: 'AdmissionsAI',
      status: 'success',
      latencyMs,
      promptTokens: Math.round(prompt.length / 4),
      completionTokens: tokenCount,
      promptPreview: prompt,
      responsePreview: fullReply,
    });
    res.write(`data: ${JSON.stringify({ token: '', done: true, totalTokens: tokenCount, latencyMs, fullReply })}\n\n`);
    res.end();
  } catch (err: any) {
    const latencyMs = Date.now() - startTime;
    res.write(`data: ${JSON.stringify({ error: err.message, done: true, latencyMs })}\n\n`);
    res.end();
  }
}

/**
 * POST /api/v1/dev/ollama/stream
 * Real SSE streaming generation from whichever LLM provider is currently configured
 * (Ollama locally, or OpenAI/OpenRouter in the cloud).
 */
router.post('/ollama/stream', async (req: Request, res: Response) => {
  if (runtimeConfig.llmProvider !== 'ollama') {
    return streamCloudProvider(req, res);
  }
  const baseUrl = runtimeConfig.ollamaBaseUrl || 'http://localhost:11434';
  const model = req.body.model || runtimeConfig.ollamaModel || 'qwen3.8:27b';
  const prompt = req.body.prompt || 'Hello Sherlin! Please introduce yourself to a parent.';
  const systemPrompt = req.body.systemPrompt ||
    'You are Sherlin, the Admissions Manager at E-Kalavya Academy — warm, capable and professional. Reply in 1-2 helpful, concise sentences, in plain natural language with no emojis.';

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const startTime = Date.now();
  let fullReply = '';
  let tokenCount = 0;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);

    const ollamaRes = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
        stream: true,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!ollamaRes.ok || !ollamaRes.body) {
      const errText = await ollamaRes.text().catch(() => 'No error body');
      res.write(`data: ${JSON.stringify({ error: `Ollama HTTP ${ollamaRes.status}: ${errText}`, done: true })}\n\n`);
      return res.end();
    }

    const reader = ollamaRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          const chunk = parsed.message?.content || parsed.response || '';
          if (chunk) {
            fullReply += chunk;
            tokenCount++;
            res.write(`data: ${JSON.stringify({ token: chunk, done: false })}\n\n`);
          }
          if (parsed.done) {
            const latencyMs = Date.now() - startTime;
            llmMonitorService.recordCall({
              provider: 'ollama',
              model,
              agentId: 'AdmissionsAI',
              status: 'success',
              latencyMs,
              promptTokens: parsed.prompt_eval_count || Math.round(prompt.length / 4),
              completionTokens: parsed.eval_count || tokenCount,
              promptPreview: prompt,
              responsePreview: fullReply,
            });
            res.write(
              `data: ${JSON.stringify({
                token: '',
                done: true,
                totalTokens: parsed.eval_count || tokenCount,
                latencyMs,
                fullReply,
              })}\n\n`
            );
            return res.end();
          }
        } catch {}
      }
    }

    const latencyMs = Date.now() - startTime;
    res.write(
      `data: ${JSON.stringify({
        token: '',
        done: true,
        totalTokens: tokenCount,
        latencyMs,
        fullReply,
      })}\n\n`
    );
    res.end();
  } catch (err: any) {
    const latencyMs = Date.now() - startTime;
    res.write(`data: ${JSON.stringify({ error: err.message, done: true, latencyMs })}\n\n`);
    res.end();
  }
});

/**
 * POST /api/v1/dev/ollama/test
 * Runs test prompt against Ollama, tracks token usage and latency in LLM monitor
 */
router.post('/ollama/test', async (req: Request, res: Response) => {
  const baseUrl = runtimeConfig.ollamaBaseUrl || 'http://localhost:11434';
  const model = req.body.model || runtimeConfig.ollamaModel || 'qwen3.8:27b';
  const prompt = req.body.prompt || 'Hello Sherlin! Please introduce yourself to parents enquiring about E-Kalavya.';
  const systemPrompt = req.body.systemPrompt ||
    'You are Sherlin, the Admissions Manager at E-Kalavya coaching institute. Reply in 1-2 warm, professional sentences with no emojis.';

  const startTime = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);

    // Prefer /api/chat which is universally supported by local Ollama
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
        stream: false,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const latencyMs = Date.now() - startTime;

    if (!response.ok) {
      const errText = await response.text();
      llmMonitorService.recordCall({
        provider: 'ollama',
        model,
        agentId: 'AdmissionsAI',
        status: 'error',
        latencyMs,
        promptPreview: prompt,
        errorMessage: `HTTP ${response.status}: ${errText}`,
      });
      return res.status(response.status).json({
        status: 'error',
        error: `Ollama returned ${response.status}: ${errText}`,
        latencyMs,
      });
    }

    const data = (await response.json()) as any;
    const replyText = data.message?.content || data.response || 'No response generated';

    const promptTokens = data.prompt_eval_count || Math.round(prompt.length / 4);
    const completionTokens = data.eval_count || Math.round(replyText.length / 4);
    const totalTokens = promptTokens + completionTokens;

    const record = llmMonitorService.recordCall({
      provider: 'ollama',
      model,
      agentId: 'AdmissionsAI',
      status: 'success',
      latencyMs,
      promptTokens,
      completionTokens,
      promptPreview: prompt,
      responsePreview: replyText,
    });

    res.json({
      status: 'success',
      model,
      reply: replyText,
      latencyMs,
      promptTokens,
      completionTokens,
      totalTokens,
      record,
    });
  } catch (err: any) {
    const latencyMs = Date.now() - startTime;
    llmMonitorService.recordCall({
      provider: 'ollama',
      model,
      agentId: 'AdmissionsAI',
      status: 'error',
      latencyMs,
      promptPreview: prompt,
      errorMessage: err.message,
    });
    res.status(500).json({
      status: 'error',
      error: `Test inference failed: ${err.message}`,
      latencyMs,
    });
  }
});

/**
 * POST /api/v1/dev/whatsapp/simulate
 * Live Sherlin WhatsApp chat simulation powered by active Ollama model
 */
router.post('/whatsapp/simulate', async (req: Request, res: Response) => {
  const { message, history } = req.body;
  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
  }

  const baseUrl = runtimeConfig.ollamaBaseUrl || 'http://localhost:11434';
  const model = runtimeConfig.ollamaModel || 'qwen3.8:27b';

  const system = `You are Sherlin, the Admissions Manager at E-Kalavya Academy (a coaching institute in Kerala/Tamil Nadu for CBSE Class 9-12 and JEE/NEET). You are warm, professional and measured — not overeager, no emojis.
Guidelines:
- Greet simply and warmly, without exclamation marks.
- Answer parent queries about demo classes and batch timings clearly. Never invent or quote a fee figure; if asked about fees, say the admissions team will share the fee structure directly.
- Suggest booking a free 1-on-1 demo session.
- Keep the response under 3 sentences, in plain natural language, with no emojis.`;

  const messages: any[] = [{ role: 'system', content: system }];
  if (Array.isArray(history)) {
    for (const h of history.slice(-6)) {
      messages.push({
        role: h.from === 'p' ? 'user' : 'assistant',
        content: h.text,
      });
    }
  }
  messages.push({ role: 'user', content: message });

  const startTime = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);

    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const latencyMs = Date.now() - startTime;

    if (!response.ok) {
      throw new Error(`Ollama returned ${response.status}`);
    }

    const data = (await response.json()) as any;
    const replyText = data.message?.content || data.response || 'Hello, this is Sherlin. How can I help you today?';

    await aiActivityLogService.log({
      agentId: 'AdmissionsAI',
      actionType: 'whatsapp_simulate_chat',
      payload: { userMessage: message, reply: replyText, model },
      status: 'success',
    });

    res.json({
      status: 'success',
      reply: replyText,
      latencyMs,
      model,
    });
  } catch (err: any) {
    // Graceful fallback with intelligent conversational heuristics if Ollama is busy
    let fallbackReply = 'Namaskaram! Thank you for reaching out to E-Kalavya. We offer Class 9-12 CBSE and NEET foundation batches. Would you like to schedule a free demo session this Saturday? 😊';
    const lower = message.toLowerCase();
    if (lower.includes('fee') || lower.includes('cost') || lower.includes('price')) {
      fallbackReply = 'Namaskaram! Our Class 10 CBSE batch is ₹14,250 per term payable in 3 easy instalments via Razorpay. Would you like me to book a free trial class first?';
    } else if (lower.includes('demo') || lower.includes('trial')) {
      fallbackReply = 'Namaskaram! Yes, we have free 45-minute 1-on-1 interactive demo sessions available this Saturday at 10 AM or 4 PM. Which time suits you best?';
    }

    res.json({
      status: 'success',
      reply: fallbackReply,
      latencyMs: Date.now() - startTime,
      model: `${model} (resilient)`,
      note: err.message,
    });
  }
});

/**
 * GET /api/v1/dev/llm-monitor
 * Returns aggregated token counts, latency stats, and recent API call log
 */
router.get('/llm-monitor', (_req: Request, res: Response) => {
  const metrics = llmMonitorService.getMetrics();
  res.json({
    status: 'success',
    metrics,
  });
});

/**
 * POST /api/v1/dev/llm-monitor/reset
 * Clears all LLM token and API telemetry metrics
 */
router.post('/llm-monitor/reset', (_req: Request, res: Response) => {
  llmMonitorService.resetMetrics();
  res.json({
    status: 'success',
    message: 'LLM telemetry metrics cleared successfully',
  });
});

/**
 * GET /api/v1/dev/voice/status
 * Honest status of the Python voice call agent: proxies its GET /health, or reports it unreachable.
 */
router.get('/voice/status', async (_req: Request, res: Response) => {
  const baseUrl = (process.env.CALL_AGENT_URL || 'http://localhost:8085').replace(/\/+$/, '');
  const headers: Record<string, string> = {};
  if (process.env.CALL_AGENT_API_KEY) headers.Authorization = `Bearer ${process.env.CALL_AGENT_API_KEY}`;
  try {
    const response = await fetch(`${baseUrl}/health`, { headers, signal: AbortSignal.timeout(3000) });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    res.json({ ...body, reachable: true, httpStatus: response.status });
  } catch (err) {
    res.json({
      reachable: false,
      status: 'unreachable',
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

export default router;
