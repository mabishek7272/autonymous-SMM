import { LeadStatus, LeadTimeline } from '@prisma/client';

/** Pure parsing helpers for the timetable and lead-sheet importers (kept free of I/O so they are easy to test). */

const DAYS: Record<string, number> = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6,
};

export function parseDay(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 6) return raw;
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase().replace(/\.$/, '');
  if (/^[0-6]$/.test(v)) return Number(v);
  return v in DAYS ? DAYS[v] : null;
}

/** "6:30 PM", "6.30pm", "18:30", "6 AM" -> "HH:mm" (24h). Returns null when it cannot be read. */
export function parseTime(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const m = raw.trim().toLowerCase().replace(/\./g, ':').match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (min > 59) return null;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    if (m[3] === 'pm' && h !== 12) h += 12;
    if (m[3] === 'am' && h === 12) h = 0;
  } else if (h > 23) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

export function minutesBetween(start: string, end: string): number {
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  return eh * 60 + em - (sh * 60 + sm);
}

/** "XII Chem" / "X 1-1 Bio" / "8th Science" -> "Class XII" / "Class X" / "Class 8"; anything else -> "General". */
export function courseNameFromBatch(batchName: string): string {
  const m = batchName.trim().match(/^(XII|XI|X|IX|VIII|VII|VI|V|IV|III|II|I|\d{1,2})(?:st|nd|rd|th)?\b/i);
  return m ? `Class ${m[1].toUpperCase()}` : 'General';
}

/** A readable, stable library name for a meeting URL when the import does not supply one. */
export function linkNameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    if (u.hostname.endsWith('teams.microsoft.com') || u.hostname.endsWith('teams.live.com')) {
      const id = parts[parts.length - 1] ?? '';
      return `Teams ${id.length > 10 ? `…${id.slice(-8)}` : id}`.trim();
    }
    if (u.hostname === 'meet.google.com') return `Google Meet ${parts[0] ?? ''}`.trim();
    if (u.hostname.endsWith('zoom.us')) return `Zoom ${(parts[parts.length - 1] ?? '').slice(-8)}`.trim();
    return `${u.hostname} ${parts[parts.length - 1] ?? ''}`.trim().slice(0, 120);
  } catch {
    return 'Class link';
  }
}

export function mapTimeline(raw: unknown): LeadTimeline | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  if (v.includes('immediate')) return 'immediately';
  if (v.includes('week')) return 'within_week';
  if (v.includes('program') || v.includes('start')) return 'when_program_starts';
  if (v.includes('enquir') || v.includes('inquir')) return 'just_enquiring';
  return null;
}

/**
 * Infers a pipeline stage from the counsellor's free-text notes. Deliberately conservative:
 * anything not clearly stated stays at 'enquiry' so nothing is silently marked lost or admitted.
 */
export function inferLeadStatus(...texts: (string | null | undefined)[]): LeadStatus {
  const t = texts.filter(Boolean).join(' ').toLowerCase();
  if (!t) return 'enquiry';
  if (/enrolled|admitted|joined/.test(t)) return 'converted';
  if (/not interested|can'?t afford|cannot afford|no budget|relocat/.test(t)) return 'lost';
  if (/demo/.test(t)) return 'demo_scheduled';
  if (/call (again|later|tmrw|tomorrow|in)|discuss|will tell|send details|price|fees?|arguing|follow/.test(t)) return 'follow_up';
  return 'enquiry';
}

/** First usable phone from "9445244497 / 7845606422", "9894320907, 98..." etc. */
export function splitPhones(raw: unknown): string[] {
  if (typeof raw !== 'string' && typeof raw !== 'number') return [];
  return String(raw).split(/[\/,;|]|\s{2,}|\sor\s/i).map((p) => p.trim()).filter(Boolean);
}
