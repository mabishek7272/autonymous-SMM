import { randomUUID } from 'crypto';
import express, { Application, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { logger, morganStream } from './utils/logger';
import { prisma } from './utils/database';
import { redis } from './utils/redis';

// Route imports
import authRoutes from './routes/auth.routes';
import userRoutes from './routes/user.routes';
import classLinkRoutes from './routes/class-link.routes';
import leadRoutes from './routes/lead.routes';
import parentRoutes from './routes/parent.routes';
import portalRoutes from './routes/portal.routes';
import studentRoutes from './routes/student.routes';
import appointmentRoutes from './routes/appointment.routes';
import academicRoutes from './routes/academic.routes';
import webhookRoutes, { metaLeadsRouter } from './routes/webhook.routes';
import messageRoutes from './routes/message.routes';
import agentRoutes from './routes/agent.routes';
import dashboardRoutes from './routes/dashboard.routes';
import devRoutes from './routes/dev.routes';
import reportRoutes from './routes/report.routes';
import reminderRoutes from './routes/reminder.routes';
import attendanceRoutes from './routes/attendance.routes';
import sessionRoutes from './routes/session.routes';
import agentApiRoutes from './routes/agent-api.routes';
import callRoutes from './routes/call.routes';

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

const app: Application = express();

// ── Security Middleware ───────────────────────────────────────
// Behind a reverse proxy req.ip / rate limiting need the proxy hop count. TRUST_PROXY: hop count, 'true'/'false', or an IP/CIDR list.
const trustProxyEnv = process.env.TRUST_PROXY ?? (process.env.NODE_ENV === 'production' ? '1' : undefined);
if (trustProxyEnv !== undefined && trustProxyEnv !== '') {
  const asNumber = Number(trustProxyEnv);
  app.set('trust proxy',
    trustProxyEnv === 'true' ? true :
    trustProxyEnv === 'false' ? false :
    Number.isInteger(asNumber) ? asNumber : trustProxyEnv);
}

// Request id on every request: echoed in X-Request-Id and in error responses/logs.
app.use((req: Request, res: Response, next: NextFunction) => {
  const incoming = req.headers['x-request-id'];
  const id = typeof incoming === 'string' && /^[\w.-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  req.requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
});

app.use(helmet());

// CORS: only origins listed in CORS_ORIGINS (comma-separated) get CORS headers (and thus credentials).
// Development defaults to the local frontends; production with no list allows no browser origin.
const allowedOrigins = (process.env.CORS_ORIGINS ?? (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:3000,http://localhost:5173'))
  .split(',').map((o) => o.trim()).filter(Boolean);
if (process.env.NODE_ENV === 'production' && allowedOrigins.length === 0) {
  logger.warn('CORS_ORIGINS is empty in production: no browser origin will be allowed');
}
app.use(cors({
  // No Origin header = non-browser caller (webhooks, curl, server-to-server); CORS does not apply.
  origin: (origin, callback) => callback(null, !origin || allowedOrigins.includes(origin)),
  credentials: true,
}));

// ── Rate Limiting ─────────────────────────────────────────────
// vitest sets VITEST=true for every test run; skipping here stops one shared in-memory limiter
// from accumulating hits across unrelated test files that exercise these routes repeatedly.
const skipInTests = () => process.env.VITEST === 'true';

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTests,
  message: { error: 'Too many requests, please try again later.' },
});
app.use(globalLimiter);

// Tighter limiter for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  skip: skipInTests,
  message: { error: 'Too many auth attempts, please try again later.' },
});

// ── Logging ───────────────────────────────────────────────────
app.use(morgan('combined', { stream: morganStream }));

// Meta lead-ads webhook needs the RAW body for its HMAC, so it is mounted before JSON parsing.
app.use('/webhooks/meta-leads', metaLeadsRouter);

// ── Body Parsing ──────────────────────────────────────────────
app.use(express.json({ limit: '1mb' })); // raise per-route only where a route really needs more
app.use(express.urlencoded({ extended: true }));

// ── Health Check ──────────────────────────────────────────────
app.get('/health', async (_req: Request, res: Response) => {
  const checks: Record<string, 'up' | 'down'> = { postgres: 'down', redis: 'down' };
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.postgres = 'up';
  } catch { /* reported below */ }
  try {
    checks.redis = (await redis.ping()) === 'PONG' ? 'up' : 'down';
  } catch { /* reported below */ }
  const healthy = Object.values(checks).every((v) => v === 'up');
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    service: 'ekalavya-api',
    checks,
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version ?? '1.0.0',
  });
});

// ── API Routes ────────────────────────────────────────────────
const API_PREFIX = '/api/v1';

app.use(`${API_PREFIX}/auth`, authLimiter, authRoutes);
app.use(`${API_PREFIX}/users`, userRoutes);
app.use(`${API_PREFIX}/class-links`, classLinkRoutes);
app.use(`${API_PREFIX}/leads`, leadRoutes);
app.use(`${API_PREFIX}/parents`, parentRoutes);
app.use(`${API_PREFIX}/portal`, portalRoutes);
app.use(`${API_PREFIX}/students`, studentRoutes);
app.use(`${API_PREFIX}/appointments`, appointmentRoutes);
app.use(`${API_PREFIX}/academic`, academicRoutes);
app.use(`${API_PREFIX}/agents`, agentRoutes);
app.use(`${API_PREFIX}/dashboard`, dashboardRoutes);
app.use(`${API_PREFIX}/dev`, devRoutes);
app.use(`${API_PREFIX}/reports`, reportRoutes);
app.use(`${API_PREFIX}/reminders`, reminderRoutes);
app.use(`${API_PREFIX}/attendance`, attendanceRoutes);
app.use(`${API_PREFIX}/sessions`, sessionRoutes);
app.use(`${API_PREFIX}/messages`, messageRoutes);
app.use(`${API_PREFIX}/agent-api`, agentApiRoutes);
app.use(`${API_PREFIX}/calls`, callRoutes);

// Webhooks (no auth — verified via signature)
app.use('/webhooks', webhookRoutes);

// ── 404 Handler ───────────────────────────────────────────────
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Route not found' });
});

// ── Global Error Handler ──────────────────────────────────────
app.use((err: Error & { status?: number; type?: string }, req: Request, res: Response, next: NextFunction) => {
  const requestId = req.requestId;
  logger.error('Unhandled error', { requestId, method: req.method, path: req.path, message: err.message, stack: err.stack });
  if (res.headersSent) {
    next(err);
    return;
  }
  // Body-parser failures are the client's fault; map them to fixed messages (never echo err.message).
  if (err.type === 'entity.too.large') { res.status(413).json({ error: 'Request body too large', requestId }); return; }
  if (err.type === 'entity.parse.failed') { res.status(400).json({ error: 'Malformed request body', requestId }); return; }
  res.status(500).json({ error: 'Internal server error', requestId });
});

export default app;
