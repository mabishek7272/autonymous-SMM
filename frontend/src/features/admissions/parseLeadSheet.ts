import type { LeadImportRow } from '../../services/api';
import { isExampleCell } from '../imports/csv';

export interface LeadSheetError {
  line: number;
  text: string;
  message: string;
}

export interface ParsedLeadSheet {
  rows: LeadImportRow[];
  errors: LeadSheetError[];
}

const clean = (c: string) => c.replace(/\*\*|__/g, '').trim();
const blank = (c: string | undefined) => {
  const v = clean(c ?? '');
  return v === '' || /^[-–—]+$/.test(v) ? undefined : v;
};

/**
 * Parses the enquiry sheet pasted from Excel/Sheets (tab- or pipe-separated):
 *   Lead name | Class | Board | Contact no. | Timeline | Notes / subject needed | Location / alt contact / remarks
 * Header rows, markdown separators and "—" placeholders are skipped. Only name and a phone are required;
 * the server validates the phone number and reports rows it cannot use.
 */
export function parseLeadSheet(raw: string): ParsedLeadSheet {
  const rows: LeadImportRow[] = [];
  const errors: LeadSheetError[] = [];

  raw.split(/\r?\n/).forEach((text, i) => {
    const line = i + 1;
    if (!text.trim()) return;
    const cells = text.split(/\t|\|/);
    if (cells.some(isExampleCell)) return;
    // Markdown tables start/end with a pipe -> drop those edge cells; tab-separated rows keep column positions
    if (text.trim().startsWith('|')) {
      while (cells.length && clean(cells[0]) === '') cells.shift();
      while (cells.length && clean(cells[cells.length - 1]) === '') cells.pop();
    }
    if (cells.length === 0 || cells.every((c) => /^:?-{2,}:?$/.test(clean(c)) || clean(c) === '')) return;

    const [name, grade, board, phone, timeline, notes, remarks] = cells.map(blank);
    if (/^(lead\s*)?name$/i.test(name ?? '') && !/\d{6,}/.test(phone ?? '')) return; // header
    if (!name) return void errors.push({ line, text, message: 'Lead name is missing (first column)' });
    if (!phone || !/\d{6,}/.test(phone.replace(/\D/g, ''))) {
      return void errors.push({ line, text, message: `"${name}": contact number is missing or not a number (4th column)` });
    }
    rows.push({ name, grade, board, phone, timeline, notes, remarks });
  });

  return { rows, errors };
}
