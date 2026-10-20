import type { StudentImportRow, TeacherImportRow } from '../../services/api';
import { isExampleCell } from './csv';

export interface SheetError {
  line: number;
  text: string;
  message: string;
}

const clean = (c: string) => c.replace(/\*\*|__/g, '').trim();
const blank = (c: string | undefined): string | undefined => {
  const v = clean(c ?? '');
  return v === '' || /^[-–—]+$/.test(v) ? undefined : v;
};
const isSeparator = (cells: string[]) => cells.every((c) => /^:?-{2,}:?$/.test(clean(c)) || clean(c) === '');

function splitLine(text: string): string[] | null {
  const cells = text.split(/\t|\|/);
  if (text.trim().startsWith('|')) {
    while (cells.length && clean(cells[0]) === '') cells.shift();
    while (cells.length && clean(cells[cells.length - 1]) === '') cells.pop();
  }
  if (cells.length === 0 || isSeparator(cells) || cells.some(isExampleCell)) return null;
  return cells;
}

/**
 * Teachers. Columns: Full name | Email | Phone | Initials | Batches (; separated) | Password (optional).
 * A header row, markdown separators, "—" placeholders and the template's EXAMPLE rows are skipped.
 */
export function parseTeacherSheet(raw: string): { rows: TeacherImportRow[]; errors: SheetError[] } {
  const rows: TeacherImportRow[] = [];
  const errors: SheetError[] = [];
  raw.split(/\r?\n/).forEach((text, i) => {
    const line = i + 1;
    if (!text.trim()) return;
    const cells = splitLine(text);
    if (!cells) return;
    const [fullName, email, phone, initials, batches, password] = cells.map(blank);
    if (/^(full\s*)?name$/i.test(fullName ?? '') && !(email ?? '').includes('@')) return; // header
    if (!fullName) return void errors.push({ line, text, message: 'Full name is missing (first column)' });
    if (!email || !email.includes('@')) return void errors.push({ line, text, message: `"${fullName}": email is missing or invalid (second column)` });
    if (!phone) return void errors.push({ line, text, message: `"${fullName}": phone number is missing (third column)` });
    rows.push({ fullName, email, phone, initials, batches, password });
  });
  return { rows, errors };
}

/**
 * Students. Columns: Student name | Parent name | Parent phone | Parent email | Class | Board |
 * Date of birth | Admission date | Batches (; separated).
 */
export function parseStudentSheet(raw: string): { rows: StudentImportRow[]; errors: SheetError[] } {
  const rows: StudentImportRow[] = [];
  const errors: SheetError[] = [];
  raw.split(/\r?\n/).forEach((text, i) => {
    const line = i + 1;
    if (!text.trim()) return;
    const cells = splitLine(text);
    if (!cells) return;
    const [studentName, parentName, parentPhone, parentEmail, grade, board, dateOfBirth, admissionDate, batches] = cells.map(blank);
    if (/^student(\s*name)?$/i.test(studentName ?? '') && !/\d{6,}/.test((parentPhone ?? '').replace(/\D/g, ''))) return; // header
    if (!studentName) return void errors.push({ line, text, message: 'Student name is missing (first column)' });
    if (!parentPhone || !/\d{6,}/.test(parentPhone.replace(/\D/g, ''))) {
      return void errors.push({ line, text, message: `"${studentName}": parent phone is missing or not a number (third column)` });
    }
    rows.push({ studentName, parentName, parentPhone, parentEmail, grade, board, dateOfBirth, admissionDate, batches });
  });
  return { rows, errors };
}
