import { Prisma, WeeklyReport } from '@prisma/client';
import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { aiActivityLogService } from './ai-activity-log.service';
import { notifyParent, delivered } from './notify.service';
import { addDaysStr, claimOnce, dateOnly, istNow, mondayOnOrBefore, withRedisLock } from './scheduler.service';

const AGENT_ID = 'WeeklyReportAI';
const WEAK_THRESHOLD = 50; // percent

export class ServiceError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface WeeklyReportMetrics {
  weekStart: string;
  weekEnd: string; // Saturday
  attendance: {
    markedDays: number;
    attendedDays: number; // present + late
    absentDays: number;
    excusedDays: number;
    percentage: number | null;
    previousPercentage: number | null;
  };
  marks: {
    assessments: number;
    percentage: number | null;
    previousPercentage: number | null;
    trend: 'up' | 'down' | 'steady' | null;
    trendDelta: number | null;
    subjects: { subject: string; percentage: number; assessments: number }[];
  };
  weakSubjects: string[];
  summarySource: 'template' | 'llm';
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Monday (YYYY-MM-DD) of the Monday-Saturday week that ends on / contains the given IST date. */
export function currentWeekStart(dateStr = istNow().dateStr): string {
  return mondayOnOrBefore(dateStr);
}

export function assertMonday(weekStartStr: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStartStr) || Number.isNaN(dateOnly(weekStartStr).getTime())) {
    throw new ServiceError(400, 'weekStart must be a YYYY-MM-DD date');
  }
  if (dateOnly(weekStartStr).getUTCDay() !== 1) throw new ServiceError(400, 'weekStart must be a Monday');
}

async function attendanceForWeek(studentId: string, weekStartStr: string) {
  const rows = await prisma.attendance.findMany({
    where: { studentId, date: { gte: dateOnly(weekStartStr), lte: dateOnly(addDaysStr(weekStartStr, 5)) } },
    select: { date: true, status: true },
  });
  // One entry per calendar day (a student in two batches may have two rows)
  const byDay = new Map<string, Set<string>>();
  for (const r of rows) {
    const k = r.date.toISOString().slice(0, 10);
    if (!byDay.has(k)) byDay.set(k, new Set());
    byDay.get(k)!.add(r.status);
  }
  let attended = 0, absent = 0, excused = 0;
  for (const statuses of byDay.values()) {
    if (statuses.has('present') || statuses.has('late')) attended++;
    else if (statuses.has('absent')) absent++;
    else excused++;
  }
  const marked = byDay.size;
  return { markedDays: marked, attendedDays: attended, absentDays: absent, excusedDays: excused, percentage: marked > 0 ? round1((attended / marked) * 100) : null };
}

async function marksForWeek(studentId: string, weekStartStr: string) {
  const records = await prisma.academicRecord.findMany({
    where: { studentId, testDate: { gte: dateOnly(weekStartStr), lte: dateOnly(addDaysStr(weekStartStr, 5)) } },
    select: { subject: true, markObtained: true, totalMarks: true },
  });
  const bySubject = new Map<string, { obtained: number; total: number; count: number }>();
  let obtained = 0, total = 0, count = 0;
  for (const r of records) {
    const t = Number(r.totalMarks ?? 0);
    if (t <= 0 || r.markObtained == null) continue;
    const o = Number(r.markObtained);
    obtained += o; total += t; count++;
    const key = r.subject?.trim() || 'General';
    const s = bySubject.get(key) ?? { obtained: 0, total: 0, count: 0 };
    s.obtained += o; s.total += t; s.count++;
    bySubject.set(key, s);
  }
  return {
    assessments: count,
    percentage: total > 0 ? round1((obtained / total) * 100) : null,
    subjects: [...bySubject.entries()].map(([subject, s]) => ({
      subject, percentage: round1((s.obtained / s.total) * 100), assessments: s.count,
    })),
  };
}

export async function computeMetrics(studentId: string, weekStartStr: string): Promise<WeeklyReportMetrics> {
  const prevStart = addDaysStr(weekStartStr, -7);
  const [att, prevAtt, marks, prevMarks] = await Promise.all([
    attendanceForWeek(studentId, weekStartStr),
    attendanceForWeek(studentId, prevStart),
    marksForWeek(studentId, weekStartStr),
    marksForWeek(studentId, prevStart),
  ]);

  let trend: WeeklyReportMetrics['marks']['trend'] = null;
  let trendDelta: number | null = null;
  if (marks.percentage != null && prevMarks.percentage != null) {
    trendDelta = round1(marks.percentage - prevMarks.percentage);
    trend = trendDelta > 2 ? 'up' : trendDelta < -2 ? 'down' : 'steady';
  }

  return {
    weekStart: weekStartStr,
    weekEnd: addDaysStr(weekStartStr, 5),
    attendance: { ...att, previousPercentage: prevAtt.percentage },
    marks: { ...marks, previousPercentage: prevMarks.percentage, trend, trendDelta },
    weakSubjects: marks.subjects.filter((s) => s.percentage < WEAK_THRESHOLD).map((s) => s.subject),
    summarySource: 'template',
  };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function formatDay(dateStr: string): string {
  const [, m, d] = dateStr.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}`;
}

/** Deterministic summary built only from the computed numbers. */
export function buildTemplateSummary(studentName: string, m: WeeklyReportMetrics): string {
  const parts: string[] = [];
  parts.push(`Weekly update for ${studentName} (${formatDay(m.weekStart)} - ${formatDay(m.weekEnd)}).`);

  const a = m.attendance;
  if (a.markedDays === 0) {
    parts.push('Attendance was not recorded this week.');
  } else {
    let line = `Attendance: attended ${a.attendedDays} of ${a.markedDays} recorded class days (${a.percentage}%).`;
    if (a.previousPercentage != null && a.percentage != null) {
      const d = round1(a.percentage - a.previousPercentage);
      line += d === 0 ? ' Same as last week.' : ` ${d > 0 ? 'Up' : 'Down'} ${Math.abs(d)} points from last week (${a.previousPercentage}%).`;
    }
    parts.push(line);
  }

  const k = m.marks;
  if (k.assessments === 0) {
    parts.push('No tests were recorded this week.');
  } else {
    let line = `Marks: ${k.assessments} test${k.assessments > 1 ? 's' : ''} this week, overall ${k.percentage}%.`;
    if (k.trend && k.trendDelta != null) {
      line += k.trend === 'steady'
        ? ` Steady compared to last week (${k.previousPercentage}%).`
        : ` ${k.trend === 'up' ? 'Improved' : 'Dropped'} by ${Math.abs(k.trendDelta)} points from last week (${k.previousPercentage}%).`;
    } else {
      line += ' No tests last week to compare with.';
    }
    parts.push(line);
    parts.push(`By subject: ${k.subjects.map((s) => `${s.subject} ${s.percentage}%`).join(', ')}.`);
  }

  if (m.weakSubjects.length > 0) {
    parts.push(`Needs extra attention: ${m.weakSubjects.join(', ')}. Regular practice at home will help.`);
  }
  return parts.join(' ');
}

/** True when a real LLM is configured for use (mirrors the provider selection in hermes.service). */
function llmEndpoint(): { url: string; model: string; headers: Record<string, string> } | null {
  if (process.env.USE_REAL_LLM !== 'true') return null;
  const provider = process.env.LLM_PROVIDER || 'ollama';
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (provider === 'ollama') {
    return {
      url: `${process.env.OLLAMA_BASE_URL || 'http://localhost:11434'}/v1/chat/completions`,
      model: process.env.OLLAMA_MODEL || 'qwen3.8:27b',
      headers,
    };
  }
  if (provider === 'openai') {
    if (!process.env.OPENAI_API_KEY) return null;
    headers.Authorization = `Bearer ${process.env.OPENAI_API_KEY}`;
    return { url: 'https://api.openai.com/v1/chat/completions', model: process.env.OPENAI_MODEL || 'gpt-4o-mini', headers };
  }
  if (provider === 'openrouter') {
    if (!process.env.OPENROUTER_API_KEY) return null;
    headers.Authorization = `Bearer ${process.env.OPENROUTER_API_KEY}`;
    headers['HTTP-Referer'] = 'https://ekalavya.in';
    headers['X-Title'] = 'E-Kalavya Academy';
    // ReportingAnalyticsAI is a backend/orchestration agent, not a WhatsApp persona — use the tool/JSON-tuned model.
    return {
      url: 'https://openrouter.ai/api/v1/chat/completions',
      model: process.env.OPENROUTER_MODEL || process.env.OPENROUTER_MODEL_BACKEND || 'z-ai/glm-5.3-flash',
      headers,
    };
  }
  if (provider === 'hub') {
    if (!process.env.HUB_API_KEY) return null;
    headers.Authorization = `Bearer ${process.env.HUB_API_KEY}`;
    return {
      url: `${(process.env.HUB_BASE_URL || 'https://hub.amgi.in/v1').replace(/\/$/, '')}/chat/completions`,
      model: process.env.HUB_MODEL || 'glm-4.7-flash',
      headers,
    };
  }
  return null;
}

/** Asks the configured LLM to rewrite the summary warmly. Returns null on any failure (caller keeps the template). */
export async function rewriteWithLlm(templateSummary: string): Promise<string | null> {
  const ep = llmEndpoint();
  if (!ep) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(ep.url, {
      method: 'POST',
      headers: ep.headers,
      body: JSON.stringify({
        model: ep.model,
        temperature: 0.4,
        messages: [
          {
            role: 'system',
            content:
              'You write short weekly progress notes from a tuition centre (E-Kalavya) to a student\'s parent, in warm, friendly English. ' +
              'Rewrite the given summary in 3-5 sentences. Keep every number, percentage and subject name exactly as given; never add facts, ' +
              'promises or numbers that are not in the summary. Plain text only, no markdown, no greeting line, no sign-off.',
          },
          { role: 'user', content: templateSummary },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      logger.warn(`Weekly report LLM returned HTTP ${res.status}; keeping template summary`);
      return null;
    }
    const data = (await res.json()) as any;
    const text = String(data?.choices?.[0]?.message?.content ?? '').trim();
    return text.length >= 20 ? text : null;
  } catch (err: any) {
    logger.warn('Weekly report LLM rewrite failed; keeping template summary', { error: err.message });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface GenerateResult {
  report: WeeklyReport;
  action: 'created' | 'regenerated' | 'kept_existing';
}

/**
 * Builds a real report from attendance + marks and upserts it as a draft.
 * An existing report that is no longer a draft (approved/sent/failed) is never overwritten,
 * and an existing draft is only regenerated with force=true so reviewer edits are not lost.
 */
export async function generateWeeklyReport(studentId: string, weekStart: string, opts: { force?: boolean } = {}): Promise<GenerateResult> {
  assertMonday(weekStart);
  const student = await prisma.student.findUnique({ where: { id: studentId }, select: { id: true, fullName: true } });
  if (!student) throw new ServiceError(404, 'Student not found');

  const weekDate = dateOnly(weekStart);
  const existing = await prisma.weeklyReport.findUnique({ where: { studentId_weekStart: { studentId, weekStart: weekDate } } });
  if (existing && (existing.status !== 'draft' || !opts.force)) {
    return { report: existing, action: 'kept_existing' };
  }

  const metrics = await computeMetrics(studentId, weekStart);
  let summary = buildTemplateSummary(student.fullName, metrics);
  const rewritten = await rewriteWithLlm(summary);
  if (rewritten) {
    summary = rewritten;
    metrics.summarySource = 'llm';
  }

  const report = await prisma.weeklyReport.upsert({
    where: { studentId_weekStart: { studentId, weekStart: weekDate } },
    create: { studentId, weekStart: weekDate, summary, metrics: metrics as unknown as Prisma.InputJsonValue, status: 'draft' },
    update: { summary, metrics: metrics as unknown as Prisma.InputJsonValue },
  });
  return { report, action: existing ? 'regenerated' : 'created' };
}

export interface BatchGenerateResult {
  weekStart: string;
  created: number;
  regenerated: number;
  keptExisting: number;
  failed: { studentId: string; error: string }[];
}

/** Generates drafts for the given students (or every active student when studentIds is undefined). */
export async function generateForStudents(weekStart: string, opts: { studentIds?: string[]; force?: boolean } = {}): Promise<BatchGenerateResult> {
  assertMonday(weekStart);
  const students = await prisma.student.findMany({
    where: { status: 'active', ...(opts.studentIds ? { id: { in: opts.studentIds } } : {}) },
    select: { id: true },
  });
  const result: BatchGenerateResult = { weekStart, created: 0, regenerated: 0, keptExisting: 0, failed: [] };
  for (const s of students) {
    try {
      const r = await generateWeeklyReport(s.id, weekStart, { force: opts.force });
      if (r.action === 'created') result.created++;
      else if (r.action === 'regenerated') result.regenerated++;
      else result.keptExisting++;
    } catch (err: any) {
      logger.error(`Weekly report generation failed for student ${s.id}`, { error: err.message });
      result.failed.push({ studentId: s.id, error: err.message });
    }
  }
  return result;
}

export function formatReportMessage(studentName: string, weekStart: string, summary: string): string {
  return (
    `📊 *E-Kalavya Weekly Report*\n` +
    `👤 *Student*: ${studentName}\n` +
    `🗓 *Week*: ${formatDay(weekStart)} - ${formatDay(addDaysStr(weekStart, 5))}\n\n` +
    `${summary}\n\n` +
    `Reply to this message anytime if you would like to speak with a teacher. 🙏`
  );
}

export type SendOutcome =
  | { reportId: string; outcome: 'sent' }
  | { reportId: string; outcome: 'skipped'; reason: string }
  | { reportId: string; outcome: 'failed'; reason: string };

/** Sends one approved (or previously failed) report. Drafts and already-sent reports are never sent. */
export async function sendReport(reportId: string): Promise<SendOutcome> {
  // Per-report lock so the scheduler, send-approved and /:id/send can never double-send the same report
  const locked = await withRedisLock(`weekly-report:send-one:${reportId}`, 120, () => sendReportUnlocked(reportId));
  if (!locked.acquired) throw new ServiceError(409, 'This report is already being sent');
  return locked.result;
}

async function sendReportUnlocked(reportId: string): Promise<SendOutcome> {
  const report = await prisma.weeklyReport.findUnique({
    where: { id: reportId },
    include: { student: { include: { parent: true } } },
  });
  if (!report) throw new ServiceError(404, 'Report not found');
  if (report.status === 'draft') throw new ServiceError(409, 'Report is still a draft and must be approved before sending');
  if (report.status === 'sent') throw new ServiceError(409, 'Report has already been sent');

  const parent = report.student.parent;
  if (parent.optedOut) return { reportId, outcome: 'skipped', reason: 'Parent has opted out of messages' };

  const weekStart = report.weekStart.toISOString().slice(0, 10);
  const weekLabel = `${formatDay(weekStart)} - ${formatDay(addDaysStr(weekStart, 5))}`;
  const result = await notifyParent({
    parent,
    studentId: report.studentId,
    agentId: AGENT_ID,
    targetId: report.studentId,
    whatsapp: parent.whatsappNumber ? formatReportMessage(report.student.fullName, weekStart, report.summary) : null,
    email: {
      kind: 'reports',
      subject: `Weekly progress report: ${report.student.fullName} (${weekLabel})`,
      title: `Weekly report for ${report.student.fullName}`,
      paragraphs: report.summary.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean),
      details: [['Student', report.student.fullName], ['Week', weekLabel]],
      footnote: 'Reply to this email if you would like to speak with a teacher.',
    },
    // unique per send: a deliberate re-send of a failed report must not be swallowed by de-duplication
    idempotencyKey: `report-${reportId}-${Date.now()}`,
  });

  if (result.whatsapp === 'failed' && result.email !== 'queued') {
    await prisma.weeklyReport.update({ where: { id: reportId }, data: { status: 'failed' } });
    await aiActivityLogService.log({ agentId: AGENT_ID, targetId: report.studentId, actionType: 'weekly_report_send', payload: { reportId, error: 'could not queue the message' }, status: 'failure' });
    return { reportId, outcome: 'failed', reason: 'Could not queue the message' };
  }
  if (!delivered(result)) {
    return { reportId, outcome: 'skipped', reason: 'Parent has no WhatsApp number or email address' };
  }

  await prisma.weeklyReport.update({ where: { id: reportId }, data: { status: 'sent', sentAt: new Date() } });
  await aiActivityLogService.log({
    agentId: AGENT_ID,
    targetId: report.studentId,
    actionType: 'weekly_report_send',
    payload: { reportId, whatsapp: result.whatsapp, email: result.email },
    status: 'success',
  });
  return { reportId, outcome: 'sent' };
}

/** Sends every approved report (optionally limited to ids). Never touches drafts. */
export async function sendApprovedReports(ids?: string[]): Promise<{ sent: number; skipped: SendOutcome[]; failed: SendOutcome[] }> {
  const reports = await prisma.weeklyReport.findMany({
    where: { status: 'approved', ...(ids ? { id: { in: ids } } : {}) },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
  let sent = 0;
  const skipped: SendOutcome[] = [];
  const failed: SendOutcome[] = [];
  for (const r of reports) {
    try {
      const o = await sendReport(r.id);
      if (o.outcome === 'sent') sent++;
      else if (o.outcome === 'skipped') skipped.push(o);
      else failed.push(o);
    } catch (err: any) {
      failed.push({ reportId: r.id, outcome: 'failed', reason: err.message });
    }
  }
  return { sent, skipped, failed };
}

/** Moves drafts to approved. Returns the ids actually approved. */
export async function approveReports(ids: string[], approvedById: string | null): Promise<string[]> {
  if (ids.length === 0) return [];
  const drafts = await prisma.weeklyReport.findMany({ where: { id: { in: ids }, status: 'draft' }, select: { id: true } });
  const draftIds = drafts.map((d) => d.id);
  if (draftIds.length === 0) return [];
  await prisma.weeklyReport.updateMany({
    where: { id: { in: draftIds }, status: 'draft' },
    data: { status: 'approved', approvedById, approvedAt: new Date() },
  });
  return draftIds;
}

// ── Scheduler ─────────────────────────────────────────────────

/** Saturday 10:00 IST: generate drafts for the week ending today. */
export async function runWeeklyGenerationJob(): Promise<BatchGenerateResult | null> {
  const now = istNow();
  if (!(await claimOnce(`weekly-report:generate:${now.dateStr}`, 6 * 3600))) return null;
  const weekStart = currentWeekStart(now.dateStr);
  logger.info(`Weekly reports: generating drafts for week starting ${weekStart}`);
  const result = await generateForStudents(weekStart);
  if (process.env.REPORTS_AUTO_APPROVE === 'true') {
    const drafts = await prisma.weeklyReport.findMany({ where: { weekStart: dateOnly(weekStart), status: 'draft' }, select: { id: true } });
    const approved = await approveReports(drafts.map((d) => d.id), null);
    logger.info(`Weekly reports: auto-approved ${approved.length} drafts (REPORTS_AUTO_APPROVE=true)`);
  }
  logger.info('Weekly reports: generation finished', { ...result, failed: result.failed.length });
  return result;
}

/** Saturday 17:00 IST: send everything approved. */
export async function runWeeklySendJob() {
  const now = istNow();
  if (!(await claimOnce(`weekly-report:send:${now.dateStr}`, 6 * 3600))) return null;
  const locked = await withRedisLock('weekly-report:send', 1800, () => sendApprovedReports());
  if (!locked.acquired) return null;
  const r = locked.result;
  logger.info(`Weekly reports: sent ${r.sent}, skipped ${r.skipped.length}, failed ${r.failed.length}`);
  return r;
}

/** Ticks every minute; fires the Saturday jobs once per day across all instances (Redis-claimed). */
export function startWeeklyReportScheduler(): NodeJS.Timeout {
  const tick = async () => {
    try {
      const now = istNow();
      if (now.dayOfWeek !== 6) return;
      if (now.hour === 10) await runWeeklyGenerationJob();
      else if (now.hour === 17) await runWeeklySendJob();
    } catch (err: any) {
      logger.error('Weekly report scheduler tick failed', { error: err.message });
    }
  };
  const timer = setInterval(tick, 60_000);
  timer.unref();
  logger.info('Weekly report scheduler started (Saturday 10:00 generate, 17:00 send, IST)');
  return timer;
}
