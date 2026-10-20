import { ClassSession } from '@prisma/client';
import { prisma } from '../utils/database';
import { redis } from '../utils/redis';
import { logger } from '../utils/logger';
import { notifyParent, notifyUser, delivered, type EmailSpec } from './notify.service';
import { aiActivityLogService } from './ai-activity-log.service';
import { istDateString, istDayRange } from './attendance.service';

const AGENT_ID = 'class-link-announcer';
const DAILY_HOUR = 7;
const DAILY_MINUTE = 30;
const TICK_MS = 5 * 60 * 1000;
const UPCOMING_WINDOW_MS = 2 * 60 * 60 * 1000;
const LOCK_KEY = 'classlink:lock';
const LOCK_TTL_S = 240;

export interface AnnounceResult {
  sessionId: string;
  parentsMessaged: number;
  parentsSkippedOptedOut: number;
  teacherMessaged: boolean;
  teacherSkippedReason?: string;
}

export function formatIstTime(d: Date): string {
  return d.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true });
}

function formatIstDate(d: Date): string {
  return d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short' });
}

function parentMessage(childNames: string[], s: ClassSession, batchName: string | null): string {
  const kids = childNames.join(' & ');
  const topic = s.topic ? ` Topic: ${s.topic}.` : '';
  return (
    `Hello! ${kids}'s ${batchName ?? 'class'} is scheduled today (${formatIstDate(s.startsAt)}) at ${formatIstTime(s.startsAt)} IST.` +
    `${topic} Join here: ${s.meetingUrl}`
  );
}

function teacherMessage(s: ClassSession, batchName: string | null): string {
  const topic = s.topic ? ` Topic: ${s.topic}.` : '';
  return (
    `Reminder: your ${batchName ?? 'class'} session is today (${formatIstDate(s.startsAt)}) at ${formatIstTime(s.startsAt)} IST.` +
    `${topic} Meeting link: ${s.meetingUrl}`
  );
}

function parentEmail(childNames: string[], s: ClassSession, batchName: string | null): EmailSpec {
  const kids = childNames.join(' & ');
  return {
    kind: 'general',
    subject: `Class today: ${batchName ?? 'your class'} at ${formatIstTime(s.startsAt)}`,
    title: `${kids}'s class is today`,
    paragraphs: [`${kids}'s ${batchName ?? 'class'} is scheduled today. Please join on time using the button below.`, ...(s.topic ? [`Topic: ${s.topic}`] : []), ...(s.notes ? [s.notes] : [])],
    details: [
      ['Class', batchName ?? ''],
      ['Date', formatIstDate(s.startsAt)],
      ['Time', `${formatIstTime(s.startsAt)} IST`],
      ['Meeting link', s.meetingUrl],
    ],
    button: { label: 'Join the class', url: s.meetingUrl },
  };
}

function teacherEmail(s: ClassSession, batchName: string | null): EmailSpec {
  return {
    kind: 'general',
    subject: `Your class today: ${batchName ?? 'class'} at ${formatIstTime(s.startsAt)}`,
    title: 'Your class is today',
    paragraphs: [`Your ${batchName ?? 'class'} session is today.`, ...(s.topic ? [`Topic: ${s.topic}`] : [])],
    details: [['Class', batchName ?? ''], ['Date', formatIstDate(s.startsAt)], ['Time', `${formatIstTime(s.startsAt)} IST`], ['Meeting link', s.meetingUrl]],
    button: { label: 'Open meeting link', url: s.meetingUrl },
  };
}

/**
 * Announces one session to enrolled students' parents and the batch teacher.
 * The announcedAt claim is an atomic compare-and-set, so concurrent callers can never double-send.
 * Returns null when the session was already announced (or does not exist).
 */
export async function announceSession(sessionId: string): Promise<AnnounceResult | null> {
  const claim = await prisma.classSession.updateMany({
    where: { id: sessionId, announcedAt: null },
    data: { announcedAt: new Date() },
  });
  if (claim.count === 0) return null;

  try {
    const session = await prisma.classSession.findUniqueOrThrow({
      where: { id: sessionId },
      include: {
        batch: {
          include: {
            teacher: { select: { id: true, fullName: true, phone: true, email: true } },
            enrollments: {
              where: { student: { status: 'active' } },
              include: { student: { include: { parent: true } } },
            },
          },
        },
      },
    });

    // One message per parent, even with several children in the batch
    const byParent = new Map<string, { number: string; email: string | null; optedOut: boolean; kids: { id: string; name: string }[] }>();
    for (const e of session.batch.enrollments) {
      const p = e.student.parent;
      const entry = byParent.get(p.id) ?? { number: p.whatsappNumber, email: p.email, optedOut: p.optedOut, kids: [] };
      entry.kids.push({ id: e.student.id, name: e.student.fullName });
      byParent.set(p.id, entry);
    }

    let parentsMessaged = 0;
    let parentsSkippedOptedOut = 0;
    let failures = 0;
    const batchName = session.batch.batchName;
    for (const [parentId, p] of byParent) {
      if (p.optedOut) { parentsSkippedOptedOut++; continue; }
      const r = await notifyParent({
        parent: { id: parentId, whatsappNumber: p.number, email: p.email, optedOut: p.optedOut },
        studentId: p.kids[0].id,
        agentId: AGENT_ID,
        targetId: session.id,
        whatsapp: parentMessage(p.kids.map((k) => k.name), session, batchName),
        email: parentEmail(p.kids.map((k) => k.name), session, batchName),
        idempotencyKey: `classlink-${session.id}-${parentId}`,
      });
      if (delivered(r)) parentsMessaged++;
      else if (r.whatsapp === 'failed' || r.email === 'failed') failures++;
    }

    let teacherMessaged = false;
    let teacherSkippedReason: string | undefined;
    const teacher = session.batch.teacher;
    if (!teacher) teacherSkippedReason = 'batch has no teacher';
    else {
      const r = await notifyUser({
        user: { id: teacher.id, email: teacher.email, phone: teacher.phone },
        agentId: AGENT_ID,
        targetId: session.id,
        whatsapp: teacher.phone ? teacherMessage(session, batchName) : null,
        email: teacherEmail(session, batchName),
        idempotencyKey: `classlink-${session.id}-teacher-${teacher.id}`,
      });
      teacherMessaged = delivered(r);
      if (!teacherMessaged) {
        teacherSkippedReason = r.whatsapp === 'failed' || r.email === 'failed' ? 'failed to queue' : 'teacher has no phone number or email';
        if (r.whatsapp === 'failed' || r.email === 'failed') failures++;
      }
    }

    // Nothing went out and something failed: release the claim so a later run retries
    if (parentsMessaged === 0 && !teacherMessaged && failures > 0) {
      await prisma.classSession.update({ where: { id: sessionId }, data: { announcedAt: null } });
      throw new Error('Could not queue any announcement messages');
    }

    // Messages are out; an audit-log failure must not release the claim (would double-send)
    await aiActivityLogService.log({
      agentId: AGENT_ID,
      targetId: sessionId,
      actionType: 'announce_class_session',
      payload: { parentsMessaged, parentsSkippedOptedOut, teacherMessaged, failures },
      status: failures > 0 ? 'failure' : 'success',
    }).catch((err) => logger.error('Class link: failed to write activity log', { sessionId, error: (err as Error).message }));

    return { sessionId, parentsMessaged, parentsSkippedOptedOut, teacherMessaged, teacherSkippedReason };
  } catch (err) {
    // Unexpected error before anything was sent: release the claim
    await prisma.classSession.updateMany({ where: { id: sessionId, announcedAt: { not: null } }, data: { announcedAt: null } })
      .catch(() => undefined);
    throw err;
  }
}

const SLOT_MATCH_WINDOW_MS = 30 * 60 * 1000;

/**
 * Turns every batch's weekly schedule into today's ClassSession rows, using the batch's standing class link.
 * Idempotent: a slot is skipped when a session for that batch already exists within 30 minutes of it
 * (created earlier by this job, or by a teacher who wanted a one-off change such as a different link/topic).
 * Returns the number of sessions created.
 */
export async function materializeTodaysSessions(now: Date = new Date()): Promise<number> {
  const ymd = istDateString(now);
  // ymd is already the IST calendar date; its weekday is the same in any timezone when read at noon UTC
  const dayOfWeek = new Date(`${ymd}T12:00:00Z`).getUTCDay();
  const { start, end } = istDayRange(ymd);

  const batches = await prisma.batch.findMany({
    where: {
      schedules: { some: { dayOfWeek } },
      OR: [{ endDate: null }, { endDate: { gte: start } }],
    },
    include: {
      classLink: { select: { meetingUrl: true, isActive: true } },
      schedules: { where: { dayOfWeek }, include: { classLink: { select: { meetingUrl: true, isActive: true } } } },
      sessions: { where: { startsAt: { gte: start, lt: end } }, select: { startsAt: true } },
    },
  });

  let created = 0;
  for (const b of batches) {
    for (const slot of b.schedules) {
      // A slot's own link wins over the batch's standing link (e.g. Friday uses a different room)
      const link = slot.classLink ?? b.classLink;
      if (!link || !link.isActive) continue;
      const startsAt = new Date(`${ymd}T${slot.startTime}:00+05:30`);
      const covered = b.sessions.some((x) => Math.abs(x.startsAt.getTime() - startsAt.getTime()) <= SLOT_MATCH_WINDOW_MS);
      if (covered) continue;
      await prisma.classSession.create({
        data: { batchId: b.id, startsAt, durationMinutes: slot.durationMinutes, meetingUrl: link.meetingUrl },
      });
      b.sessions.push({ startsAt });
      created++;
    }
  }
  return created;
}

async function announceWhere(startsFrom: Date, startsBefore: Date): Promise<AnnounceResult[]> {
  const sessions = await prisma.classSession.findMany({
    where: { announcedAt: null, startsAt: { gte: startsFrom, lt: startsBefore } },
    orderBy: { startsAt: 'asc' },
    select: { id: true, startsAt: true, durationMinutes: true },
  });
  const now = Date.now();
  const results: AnnounceResult[] = [];
  for (const s of sessions) {
    if (s.startsAt.getTime() + s.durationMinutes * 60_000 < now) continue; // already over
    try {
      const r = await announceSession(s.id);
      if (r) results.push(r);
    } catch (err) {
      logger.error('Class link: announce failed', { sessionId: s.id, error: (err as Error).message });
    }
  }
  return results;
}

/** Announces every not-yet-announced, not-yet-finished session of today (IST). */
export async function announceTodaysSessions(): Promise<AnnounceResult[]> {
  const { start, end } = istDayRange(istDateString());
  return announceWhere(start, end);
}

/** Announces unannounced sessions that start within the next 2 hours (and still today, IST). */
export async function announceUpcomingSessions(now: Date = new Date()): Promise<AnnounceResult[]> {
  const { end } = istDayRange(istDateString(now));
  const horizon = new Date(Math.min(now.getTime() + UPCOMING_WINDOW_MS, end.getTime()));
  const { start } = istDayRange(istDateString(now));
  return announceWhere(start, horizon);
}

async function withLock<T>(fn: () => Promise<T>): Promise<T | undefined> {
  const token = `${process.pid}:${Date.now()}`;
  const got = await redis.set(LOCK_KEY, token, 'EX', LOCK_TTL_S, 'NX');
  if (got !== 'OK') return undefined; // another instance is running
  try {
    return await fn();
  } finally {
    if ((await redis.get(LOCK_KEY).catch(() => null)) === token) await redis.del(LOCK_KEY).catch(() => undefined);
  }
}

/** One scheduler pass; exported for tests. */
export async function classLinkTick(now: Date = new Date()): Promise<void> {
  await withLock(async () => {
    // Scheduled slots become today's sessions (with the batch's standing link) before anything is announced
    const made = await materializeTodaysSessions(now);
    if (made) logger.info(`Class link: created ${made} scheduled session(s) for today`);
    const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
    const pastDailyTime = ist.getUTCHours() * 60 + ist.getUTCMinutes() >= DAILY_HOUR * 60 + DAILY_MINUTE;
    if (pastDailyTime) {
      // Once per IST day across all instances; catches up if the server was down at 07:30
      const dailyKey = `classlink:daily:${istDateString(now)}`;
      if ((await redis.set(dailyKey, '1', 'EX', 36 * 3600, 'NX')) === 'OK') {
        try {
          const r = await announceTodaysSessions();
          logger.info(`Class link daily run: announced ${r.length} session(s)`);
        } catch (err) {
          await redis.del(dailyKey).catch(() => undefined);
          throw err;
        }
      }
    }
    const upcoming = await announceUpcomingSessions(now);
    if (upcoming.length) logger.info(`Class link: announced ${upcoming.length} upcoming session(s)`);
  });
}

let timer: NodeJS.Timeout | null = null;

/** Starts the 5-minute scheduler. Idempotent; safe to call once per API instance. */
export function startClassLinkScheduler(): void {
  if (timer) return;
  const run = () => classLinkTick().catch((err) => logger.error('Class link scheduler tick failed', { error: (err as Error).message }));
  timer = setInterval(run, TICK_MS);
  timer.unref();
  void run();
  logger.info('Class link scheduler started (daily 07:30 IST + 5-minute pickup)');
}

export function stopClassLinkScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
