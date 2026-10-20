import type { TimetableImportRow } from '../../services/api';
import { isExampleCell } from '../imports/csv';

export interface TimetableLineError {
  line: number;
  text: string;
  message: string;
}

export interface ParsedTimetable {
  rows: TimetableImportRow[];
  errors: TimetableLineError[];
}

const DAY = /^(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)[a-z]*\.?$/i;
const URL_RE = /https?:\/\/[^\s)\]>"]+/i;
const RANGE = /^(\d{1,2}(?::\d{2})?)\s*(am|pm)?\s*[-–—]\s*(\d{1,2}(?::\d{2})?)\s*(am|pm)$/i;

const clean = (c: string) => c.replace(/\*\*|__/g, '').trim();
const isDashes = (c: string) => /^:?-{2,}:?$/.test(c);

/** "11:30 – 12:30 PM" -> 11:30 is AM; "6:30 – 7:30 PM" -> both PM. */
function resolveRange(text: string): { start: string; end: string } | null {
  const m = RANGE.exec(text.trim());
  if (!m) return null;
  const endMer = m[4].toUpperCase();
  const startHour = Number(m[1].split(':')[0]);
  const endHour = Number(m[3].split(':')[0]);
  let startMer = m[2]?.toUpperCase();
  if (!startMer) startMer = endMer === 'PM' && startHour !== 12 && (startHour > endHour || endHour === 12) ? 'AM' : endMer;
  return { start: `${m[1]} ${startMer}`, end: `${m[3]} ${endMer}` };
}

/**
 * Parses a timetable pasted from a sheet or document (tab- or pipe-separated):
 *   Day | Time slot | Class & subject | Faculty / students | Meeting link
 * The day is only written on the first row of each day and carries down. Markdown bold and
 * "[Join Teams](https://…)" link cells are understood. The faculty column is ignored.
 */
export function parseTimetablePaste(raw: string): ParsedTimetable {
  const rows: TimetableImportRow[] = [];
  const errors: TimetableLineError[] = [];
  let currentDay: string | null = null;

  raw.split(/\r?\n/).forEach((text, i) => {
    const line = i + 1;
    if (!text.trim()) return;
    const cells = text.split(/\t|\|/).map(clean);
    if (cells.some(isExampleCell)) return;
    // Markdown tables start/end with a pipe -> drop those edge cells. Tab-separated rows keep their
    // positions: an empty first cell (day carried down) is meaningful.
    if (text.trim().startsWith('|')) {
      while (cells.length && cells[0] === '') cells.shift();
      while (cells.length && cells[cells.length - 1] === '') cells.pop();
    }
    if (cells.length === 0 || cells.every((c) => isDashes(c) || c === '')) return;

    const url = URL_RE.exec(text)?.[0] ?? null;
    if (!url && /^day$/i.test(cells[0] ?? '')) return; // header row

    let range: { start: string; end: string } | null = null;
    const rest: string[] = [];
    let sawTimeLikeCell = false;
    for (const c of cells) {
      if (!c) continue;
      if (URL_RE.test(c)) continue;
      if (DAY.test(c) && c.length <= 12) {
        currentDay = c;
        continue;
      }
      const r = resolveRange(c);
      if (r) {
        range = r;
        continue;
      }
      if (/\d\s*[-–—]\s*\d/.test(c) && /(am|pm)/i.test(c)) sawTimeLikeCell = true;
      rest.push(c);
    }

    if (!range) {
      // A line that is only a day label (or a stray heading) is not an error
      if (!url && rest.length === 0) return;
      return void errors.push({ line, text, message: sawTimeLikeCell ? 'Cannot read the time slot (expected like "6:30 – 7:30 PM")' : 'No time slot found' });
    }
    const batchName = rest[0];
    if (!currentDay) return void errors.push({ line, text, message: 'No day found yet (start with the day, e.g. Monday)' });
    if (!batchName) return void errors.push({ line, text, message: 'Class & subject is missing' });
    if (!url) return void errors.push({ line, text, message: 'Meeting link is missing' });
    if (!url.toLowerCase().startsWith('https://')) return void errors.push({ line, text, message: 'Meeting link must be https' });
    rows.push({ batchName, day: currentDay, startTime: range.start, endTime: range.end, meetingUrl: url });
  });

  return { rows, errors };
}
