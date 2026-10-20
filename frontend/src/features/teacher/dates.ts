/** Asia/Kolkata date helpers: the backend defines "today" and class days in IST. */

const IST = 'Asia/Kolkata';

interface IstParts {
  date: string; // YYYY-MM-DD
  time: string; // HH:mm
}

export function istParts(d: Date): IstParts {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: IST,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '00';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
}

export function todayIst(now: Date = new Date()): string {
  return istParts(now).date;
}

export function addDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Value for <input type="datetime-local"> showing the IST wall-clock time of an ISO instant. */
export function isoToIstLocalInput(iso: string): string {
  const p = istParts(new Date(iso));
  return `${p.date}T${p.time}`;
}

/** Interprets a datetime-local value as IST and returns an ISO string with offset. */
export function istLocalInputToIso(value: string): string {
  return `${value}:00+05:30`;
}

export function formatYmd(ymd: string): string {
  return new Date(`${ymd}T00:00:00Z`).toLocaleDateString('en-IN', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatTimeIst(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-IN', { timeZone: IST, hour: 'numeric', minute: '2-digit' });
}

export function formatDateTimeIst(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', { timeZone: IST, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

/** Date part (YYYY-MM-DD) of an ISO instant in IST. */
export function istDateOf(iso: string): string {
  return istParts(new Date(iso)).date;
}

/** Date-only columns arrive as ISO timestamps at UTC midnight: take the calendar date as stored. */
export function dateOnly(iso: string): string {
  return iso.slice(0, 10);
}
