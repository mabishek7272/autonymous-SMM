/** Small, dependency-free CSV helpers for the import screens (RFC 4180 quoting; comma, semicolon or tab separated). */

function detectDelimiter(text: string): ',' | ';' | '\t' {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const count = (ch: string) => (firstLine.match(new RegExp(`\\${ch}`, 'g')) ?? []).length;
  const tab = count('\t');
  const comma = count(',');
  const semi = count(';');
  if (tab >= comma && tab >= semi && tab > 0) return '\t';
  return semi > comma ? ';' : ',';
}

export function parseCsv(input: string): string[][] {
  const text = input.replace(/^﻿/, '');
  const delimiter = detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** Uploaded CSV -> the tab-separated text the paste parsers understand. */
export function csvToTsv(input: string): string {
  return parseCsv(input)
    .map((r) => r.map((c) => c.replace(/[\t\r\n]+/g, ' ').trim()).join('\t'))
    .join('\n');
}

const needsQuotes = /[",\n\r;]/;
const quote = (c: string) => (needsQuotes.test(c) ? `"${c.replace(/"/g, '""')}"` : c);

export function buildCsv(header: readonly string[], rows: readonly (readonly string[])[]): string {
  return [header, ...rows].map((r) => r.map(quote).join(',')).join('\r\n') + '\r\n';
}

/** Triggers a browser download. A BOM is added so Excel opens UTF-8 (Tamil names) correctly. */
export function downloadTextFile(filename: string, content: string, mime = 'text/csv;charset=utf-8'): void {
  const blob = new Blob(['﻿', content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Template sample rows start with "EXAMPLE –" so they can never be imported by accident. */
export const EXAMPLE_PREFIX = /^EXAMPLE\s*[–—:-]/i;
export const isExampleCell = (c: string | undefined): boolean => EXAMPLE_PREFIX.test((c ?? '').replace(/\*\*|__/g, '').trim());
