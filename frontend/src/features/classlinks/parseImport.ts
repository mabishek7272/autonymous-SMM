import type { ClassLinkInput } from '../../services/api';
import { isExampleCell } from '../imports/csv';

export interface ImportLineError {
  line: number;
  text: string;
  message: string;
}

export interface ParsedImport {
  links: ClassLinkInput[];
  errors: ImportLineError[];
}

const HEADER = /^(name|class|title)$/i;

function isHttps(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Parses pasted rows (copied from Excel/Sheets: tab-separated, or "|"-separated) into class links.
 * Columns: Name, Link, Class (optional), Board (optional), Subject (optional). A header row is skipped.
 */
export function parseLinkImport(raw: string): ParsedImport {
  const links: ClassLinkInput[] = [];
  const errors: ImportLineError[] = [];
  const seen = new Set<string>();

  raw.split(/\r?\n/).forEach((text, i) => {
    const line = i + 1;
    if (!text.trim()) return;
    const cells = text.split(/\t|\|/).map((c) => c.trim());
    if (cells.some(isExampleCell)) return;
    if (i === 0 && HEADER.test(cells[0] ?? '') && !isHttps(cells[1] ?? '')) return;

    const [name = '', meetingUrl = '', grade = '', board = '', subject = ''] = cells;
    if (name.length < 2) return void errors.push({ line, text, message: 'Name is missing (first column)' });
    if (name.length > 120) return void errors.push({ line, text, message: 'Name is longer than 120 characters' });
    if (!isHttps(meetingUrl)) return void errors.push({ line, text, message: 'Second column must be an https link' });
    const key = name.toLowerCase();
    if (seen.has(key)) return void errors.push({ line, text, message: `Duplicate name "${name}" in this list` });
    seen.add(key);

    links.push({ name, meetingUrl, grade: grade || null, board: board || null, subject: subject || null });
  });

  return { links, errors };
}
