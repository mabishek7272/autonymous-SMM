/** Date helpers for the weekly (Mon-Sat) report cycle. All calendar maths is done on IST dates (YYYY-MM-DD). */

const IST_OFFSET_MINUTES = 330;

function parse(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00Z`);
}

export function addDays(dateStr: string, days: number): string {
  const d = parse(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Today's calendar date in Asia/Kolkata. */
export function istToday(nowMs: number = Date.now()): string {
  return new Date(nowMs + IST_OFFSET_MINUTES * 60_000).toISOString().slice(0, 10);
}

export function mondayOnOrBefore(dateStr: string): string {
  const dow = parse(dateStr).getUTCDay();
  return addDays(dateStr, -((dow + 6) % 7));
}

/** Monday of the most recent week whose Saturday has already passed. */
export function lastCompletedWeekStart(today: string): string {
  const monday = mondayOnOrBefore(today);
  return parse(today).getUTCDay() === 0 ? monday : addDays(monday, -7);
}

function short(dateStr: string): string {
  return parse(dateStr).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

export function formatWeekRange(monday: string): string {
  return `${short(monday)} to ${short(addDays(monday, 5))}`;
}

export interface WeekOption {
  value: string;
  label: string;
}

/** The current week followed by earlier weeks, newest first. */
export function weekOptions(today: string, count = 12): WeekOption[] {
  const current = mondayOnOrBefore(today);
  const lastDone = lastCompletedWeekStart(today);
  return Array.from({ length: count }, (_, i) => {
    const monday = addDays(current, -7 * i);
    const note = monday === lastDone ? ' (last completed)' : monday === current && current !== lastDone ? ' (in progress)' : '';
    return { value: monday, label: `${formatWeekRange(monday)}${note}` };
  });
}

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

export function formatIstTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
}

export function formatIstDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
}
