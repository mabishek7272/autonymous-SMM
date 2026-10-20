import { prisma } from '../utils/database';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Calendar date (YYYY-MM-DD) of an instant in Asia/Kolkata. */
export function istDateString(d: Date = new Date()): string {
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Parses 'YYYY-MM-DD' to UTC midnight (how Prisma stores @db.Date); null if not a real date. */
export function parseYmd(s: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : d;
}

/** Start/end instants of an IST calendar day (end exclusive). */
export function istDayRange(ymd: string): { start: Date; end: Date } {
  const start = new Date(`${ymd}T00:00:00+05:30`);
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function dateOnly(d: Date): Date {
  return new Date(`${d.toISOString().slice(0, 10)}T00:00:00.000Z`);
}

/** present + late count as attended; every marked row (a batch-day) counts as a marked day. */
export async function computeAttendancePercentage(
  studentId: string,
  from: Date,
  to: Date
): Promise<{ markedDays: number; presentDays: number; percentage: number | null }> {
  const rows = await prisma.attendance.groupBy({
    by: ['status'],
    where: { studentId, date: { gte: dateOnly(from), lte: dateOnly(to) } },
    _count: { _all: true },
  });
  let markedDays = 0;
  let presentDays = 0;
  for (const r of rows) {
    markedDays += r._count._all;
    if (r.status === 'present' || r.status === 'late') presentDays += r._count._all;
  }
  return {
    markedDays,
    presentDays,
    percentage: markedDays > 0 ? round1((presentDays / markedDays) * 100) : null,
  };
}

/** Each calendar day in [from, to] (inclusive) as YYYY-MM-DD. */
export function eachDay(from: Date, to: Date): string[] {
  const out: string[] = [];
  for (let t = from.getTime(); t <= to.getTime(); t += 24 * 60 * 60 * 1000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}
