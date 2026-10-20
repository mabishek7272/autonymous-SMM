import { randomUUID } from 'crypto';
import { redis } from '../utils/redis';
import { logger } from '../utils/logger';

/**
 * Shared cron / Asia/Kolkata helpers. IST is a fixed UTC+05:30 (no DST), so we
 * shift the instant by the offset and read the UTC fields.
 */
const IST_OFFSET_MS = 330 * 60 * 1000;

export interface IstParts {
  year: number;
  month: number;      // 1-12
  day: number;
  hour: number;
  minute: number;
  dayOfWeek: number;  // 0=Sunday ... 6=Saturday
  dateStr: string;    // YYYY-MM-DD (IST calendar date)
  timeStr: string;    // HH:mm (IST)
}

const pad = (n: number) => String(n).padStart(2, '0');

export function istParts(date: Date): IstParts {
  const s = new Date(date.getTime() + IST_OFFSET_MS);
  const year = s.getUTCFullYear();
  const month = s.getUTCMonth() + 1;
  const day = s.getUTCDate();
  const hour = s.getUTCHours();
  const minute = s.getUTCMinutes();
  return {
    year, month, day, hour, minute,
    dayOfWeek: s.getUTCDay(),
    dateStr: `${year}-${pad(month)}-${pad(day)}`,
    timeStr: `${pad(hour)}:${pad(minute)}`,
  };
}

export function istNow(): IstParts {
  return istParts(new Date());
}

/** UTC-midnight Date for a YYYY-MM-DD string — the representation used for `@db.Date` columns. */
export function dateOnly(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00.000Z`);
}

/** Calendar arithmetic on YYYY-MM-DD strings. */
export function addDaysStr(dateStr: string, days: number): string {
  const d = dateOnly(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The real instant at which the given IST calendar date begins. */
export function istDayStart(dateStr: string): Date {
  return new Date(dateOnly(dateStr).getTime() - IST_OFFSET_MS);
}

/** The IST date of the Monday on or before the given IST date (Sunday maps to the previous Monday). */
export function mondayOnOrBefore(dateStr: string): string {
  const dow = dateOnly(dateStr).getUTCDay();
  return addDaysStr(dateStr, -((dow + 6) % 7));
}

/**
 * Runs fn only if the lock is free; releases it afterwards. Returns acquired:false
 * (without running fn) when another holder owns the lock. Redis errors propagate.
 */
export async function withRedisLock<T>(
  key: string,
  ttlSeconds: number,
  fn: () => Promise<T>
): Promise<{ acquired: true; result: T } | { acquired: false }> {
  const token = randomUUID();
  const ok = await redis.set(`lock:${key}`, token, 'EX', ttlSeconds, 'NX');
  if (ok !== 'OK') return { acquired: false };
  try {
    return { acquired: true, result: await fn() };
  } finally {
    try {
      // Only delete the lock if we still own it
      await redis.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        1, `lock:${key}`, token
      );
    } catch (err: any) {
      logger.warn(`Failed to release lock ${key}`, { error: err.message });
    }
  }
}

/** Marks a once-per-slot job as claimed (SET NX EX, never released). True if this caller won. */
export async function claimOnce(key: string, ttlSeconds: number): Promise<boolean> {
  return (await redis.set(`once:${key}`, '1', 'EX', ttlSeconds, 'NX')) === 'OK';
}
