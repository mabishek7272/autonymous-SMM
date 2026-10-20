import { REMINDER_TEMPLATE_PLACEHOLDERS } from '../../types';

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/** Mirrors the backend validation: names used in the template that the backend would reject. */
export function unknownPlaceholders(template: string): string[] {
  const allowed: readonly string[] = REMINDER_TEMPLATE_PLACEHOLDERS;
  const found = [...template.matchAll(PLACEHOLDER_RE)].map((m) => m[1] ?? '');
  return [...new Set(found.filter((f) => !allowed.includes(f)))];
}

export interface TemplatePart {
  text: string;
  placeholder: boolean;
}

/** Splits a template into plain text and placeholder tokens for highlighted display. */
export function splitTemplate(template: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let last = 0;
  for (const m of template.matchAll(PLACEHOLDER_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) parts.push({ text: template.slice(last, idx), placeholder: false });
    parts.push({ text: m[0], placeholder: true });
    last = idx + m[0].length;
  }
  if (last < template.length) parts.push({ text: template.slice(last), placeholder: false });
  return parts;
}

/** Template text offered by the empty state's "default Monday 9:00 reminder" button. */
export const MONDAY_REMINDER_TEMPLATE =
  'Hi {{teacherName}}, a reminder to mark attendance for {{batchNames}}. You have {{pendingAttendanceDays}} day(s) pending and {{sessionsToday}} session(s) today.';
