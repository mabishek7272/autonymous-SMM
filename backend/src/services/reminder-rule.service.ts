import { ReminderRule } from '@prisma/client';
import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { enqueueWhatsApp } from '../utils/queues';
import { notifyUser } from './notify.service';
import { isEmailEnabled, isValidEmail } from './email.service';
import { aiActivityLogService } from './ai-activity-log.service';
import { addDaysStr, dateOnly, istDayStart, istParts, withRedisLock } from './scheduler.service';

const AGENT_ID = 'ReminderRuleEngine';

export const TEMPLATE_PLACEHOLDERS = ['teacherName', 'pendingAttendanceDays', 'batchNames', 'sessionsToday'] as const;

export interface TeacherReminderData {
  teacherName: string;
  pendingAttendanceDays: number;
  batchNames: string;
  sessionsToday: number;
}

/** Returns the unknown placeholders used in a template (empty when valid). */
export function unknownPlaceholders(template: string): string[] {
  const found = [...template.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1]);
  return [...new Set(found.filter((f) => !(TEMPLATE_PLACEHOLDERS as readonly string[]).includes(f)))];
}

export function renderTemplate(template: string, data: TeacherReminderData): string {
  const values: Record<string, string> = {
    teacherName: data.teacherName,
    pendingAttendanceDays: String(data.pendingAttendanceDays),
    batchNames: data.batchNames,
    sessionsToday: String(data.sessionsToday),
  };
  return template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (whole, key) => (key in values ? values[key] : whole));
}

/**
 * Real per-teacher numbers.
 * pendingAttendanceDays: of the 7 IST days before today (Sundays excluded), the days on which at least one
 * of the teacher's running batches that had class that day has no attendance rows. A batch "had class" on days
 * it has a ClassSession; a batch with no sessions in the window is treated as meeting Monday to Saturday.
 */
export async function buildTeacherData(teacher: { id: string; fullName: string }, now = new Date()): Promise<TeacherReminderData> {
  const today = istParts(now).dateStr;
  const windowStart = addDaysStr(today, -7);
  const windowEnd = addDaysStr(today, -1);

  const batches = await prisma.batch.findMany({
    where: { teacherId: teacher.id },
    select: { id: true, batchName: true, startDate: true, endDate: true, _count: { select: { enrollments: true } } },
  });
  const batchIds = batches.map((b) => b.id);
  const names = batches.map((b) => b.batchName).filter((n): n is string => !!n);

  if (batchIds.length === 0) {
    return { teacherName: teacher.fullName, pendingAttendanceDays: 0, batchNames: 'no batches assigned', sessionsToday: 0 };
  }

  const [sessions, attendance] = await Promise.all([
    prisma.classSession.findMany({
      where: { batchId: { in: batchIds }, startsAt: { gte: istDayStart(windowStart), lt: istDayStart(addDaysStr(today, 1)) } },
      select: { batchId: true, startsAt: true },
    }),
    prisma.attendance.findMany({
      where: { batchId: { in: batchIds }, date: { gte: dateOnly(windowStart), lte: dateOnly(windowEnd) } },
      select: { batchId: true, date: true },
    }),
  ]);

  const sessionsToday = sessions.filter((s) => istParts(s.startsAt).dateStr === today).length;
  const sessionDays = new Map<string, Set<string>>();
  for (const s of sessions) {
    const d = istParts(s.startsAt).dateStr;
    if (d >= today) continue; // today's sessions only feed sessionsToday
    if (!sessionDays.has(s.batchId)) sessionDays.set(s.batchId, new Set());
    sessionDays.get(s.batchId)!.add(d);
  }
  const marked = new Set(attendance.map((a) => `${a.batchId}|${a.date.toISOString().slice(0, 10)}`));

  const pending = new Set<string>();
  for (let i = 7; i >= 1; i--) {
    const day = addDaysStr(today, -i);
    if (dateOnly(day).getUTCDay() === 0) continue; // Sunday
    for (const b of batches) {
      if (b._count.enrollments === 0) continue;
      if (b.startDate && b.startDate.toISOString().slice(0, 10) > day) continue;
      if (b.endDate && b.endDate.toISOString().slice(0, 10) < day) continue;
      const days = sessionDays.get(b.id);
      const hadClass = days ? days.has(day) : true;
      if (hadClass && !marked.has(`${b.id}|${day}`)) pending.add(day);
    }
  }

  return {
    teacherName: teacher.fullName,
    pendingAttendanceDays: pending.size,
    batchNames: names.length ? names.join(', ') : 'your batches',
    sessionsToday,
  };
}

function normalizePhone(raw: string): string | null {
  let digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1); // trunk prefix
  if (digits.length === 10) return `91${digits}`;
  if (digits.length >= 11 && digits.length <= 15) return digits;
  return null;
}

export interface RuleRunResult {
  ruleId: string;
  ruleName: string;
  audience: string;
  sent: number;
  skipped: { teacherId: string; name: string; reason: string }[];
  failed: { teacherId: string; name: string; error: string }[];
  note?: string;
}

/** Sends one rule to its audience now, regardless of schedule. */
export async function runRule(rule: ReminderRule, now = new Date()): Promise<RuleRunResult> {
  const result: RuleRunResult = { ruleId: rule.id, ruleName: rule.name, audience: rule.audience, sent: 0, skipped: [], failed: [] };

  if (rule.audience !== 'teacher') {
    result.note = 'Parent-audience reminders are not supported by the rule runner yet; nothing was sent';
    return result;
  }

  const teachers = await prisma.user.findMany({
    where: { role: 'teacher', isActive: true },
    select: { id: true, fullName: true, phone: true, email: true },
    orderBy: { fullName: 'asc' },
  });

  for (const t of teachers) {
    const to = t.phone ? normalizePhone(t.phone) : null;
    const canEmail = isEmailEnabled() && isValidEmail(t.email);
    if (!to && !canEmail) {
      result.skipped.push({ teacherId: t.id, name: t.fullName, reason: t.phone ? 'Invalid phone number and no usable email' : 'No phone number or email on file' });
      continue;
    }
    try {
      const text = renderTemplate(rule.template, await buildTeacherData(t, now));
      if (to) {
        const row = await prisma.message.create({
          data: { direction: 'outbound', channel: 'whatsapp', body: text, status: 'queued', agentId: AGENT_ID },
        });
        try {
          await enqueueWhatsApp({ to, text, agentId: AGENT_ID, targetId: t.id, messageId: row.id });
        } catch (err) {
          await prisma.message.update({ where: { id: row.id }, data: { status: 'failed:enqueue' } }).catch(() => undefined);
          if (!canEmail) throw err;
          logger.error(`Reminder rule ${rule.id}: WhatsApp failed for teacher ${t.id}, email still sent`, { error: (err as Error).message });
        }
      }
      // Same reminder by email (never throws; the queue retries and records failures)
      await notifyUser({
        user: { id: t.id, email: t.email, phone: null },
        agentId: AGENT_ID,
        targetId: t.id,
        email: { kind: 'general', subject: rule.name, title: rule.name, paragraphs: text.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean) },
      });
      result.sent++;
    } catch (err: any) {
      logger.error(`Reminder rule ${rule.id} failed for teacher ${t.id}`, { error: err.message });
      result.failed.push({ teacherId: t.id, name: t.fullName, error: err.message });
    }
  }

  await aiActivityLogService.log({
    agentId: AGENT_ID,
    targetId: rule.id,
    actionType: 'reminder_rule_run',
    payload: { sent: result.sent, skipped: result.skipped.length, failed: result.failed.length },
    status: result.failed.length > 0 && result.sent === 0 ? 'failure' : 'success',
  });
  return result;
}

/** Manual trigger from the API. Records lastRunAt like a scheduled run. */
export async function runRuleNow(ruleId: string): Promise<RuleRunResult | null> {
  const rule = await prisma.reminderRule.findUnique({ where: { id: ruleId } });
  if (!rule) return null;
  const result = await runRule(rule);
  if (rule.audience === 'teacher') await prisma.reminderRule.update({ where: { id: rule.id }, data: { lastRunAt: new Date() } });
  return result;
}

/**
 * Runs every enabled teacher rule whose day/time (IST) is the current minute and that has not already
 * run in this minute. The lastRunAt claim is a single atomic UPDATE so concurrent instances cannot double-send.
 */
export async function runDueRules(now = new Date()): Promise<RuleRunResult[]> {
  const ist = istParts(now);
  const minuteStart = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const due = await prisma.reminderRule.findMany({
    where: { enabled: true, audience: 'teacher', dayOfWeek: ist.dayOfWeek, timeOfDay: ist.timeStr },
  });

  const results: RuleRunResult[] = [];
  for (const rule of due) {
    const claim = await prisma.reminderRule.updateMany({
      where: { id: rule.id, OR: [{ lastRunAt: null }, { lastRunAt: { lt: minuteStart } }] },
      data: { lastRunAt: now },
    });
    if (claim.count === 0) continue; // already run in this minute
    results.push(await runRule(rule, now));
  }
  return results;
}

/** Ticks every 30s; the Redis lock keeps multiple instances from running at once. */
export function startReminderRuleScheduler(): NodeJS.Timeout {
  const tick = async () => {
    try {
      const locked = await withRedisLock('reminder-rules:tick', 25, () => runDueRules());
      if (locked.acquired && locked.result.length > 0) {
        logger.info('Reminder rules ran', { rules: locked.result.map((r) => ({ id: r.ruleId, sent: r.sent, skipped: r.skipped.length, failed: r.failed.length })) });
      }
    } catch (err: any) {
      logger.error('Reminder rule scheduler tick failed', { error: err.message });
    }
  };
  const timer = setInterval(tick, 30_000);
  timer.unref();
  logger.info('Reminder rule scheduler started (30s tick, IST)');
  return timer;
}

export const DEFAULT_TEACHER_TEMPLATE =
  'Good morning {{teacherName}}! Weekly reminder from E-Kalavya: you have {{pendingAttendanceDays}} day(s) of attendance still to be marked for {{batchNames}} in the last 7 days. ' +
  'Please mark attendance and enter this week\'s test marks. You have {{sessionsToday}} session(s) scheduled today. Thank you!';

/** Creates the one default rule if no rules exist. Not called automatically. */
export async function seedDefaultReminderRule(): Promise<ReminderRule | null> {
  if ((await prisma.reminderRule.count()) > 0) return null;
  return prisma.reminderRule.create({
    data: { name: 'Weekly attendance and marks reminder', audience: 'teacher', dayOfWeek: 1, timeOfDay: '09:00', template: DEFAULT_TEACHER_TEMPLATE, enabled: true },
  });
}

