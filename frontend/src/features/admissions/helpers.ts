import type { LeadSource, LeadWithParent } from '../../types';

/** Form choices (not data): the backend stores grade and board as free text. */
export const GRADE_OPTIONS = ['Class 6', 'Class 7', 'Class 8', 'Class 9', 'Class 10', 'Class 11', 'Class 12'] as const;
export const BOARD_OPTIONS = ['CBSE', 'ICSE', 'State Board', 'IGCSE', 'IB'] as const;
export const SUBJECT_OPTIONS = ['Maths', 'Science', 'Physics', 'Chemistry', 'Biology', 'English', 'Social Science', 'Computer Science'] as const;
export const PAYMENT_MODES = ['UPI', 'Cash', 'Card', 'Bank Transfer', 'Cheque'] as const;

const SOURCE_LABELS: Record<LeadSource, string> = {
  Meta: 'Meta',
  Website: 'Website',
  Referral: 'Referral',
  GoogleSheets: 'Google Sheets',
};

export function sourceLabel(source: LeadSource): string {
  return SOURCE_LABELS[source];
}

export function leadName(lead: LeadWithParent): string {
  return lead.parent.fullName;
}

/** "Class 9 · CBSE · Maths, Science" from whatever the lead really has; null when nothing is captured. */
export function academicLine(lead: LeadWithParent): string | null {
  const parts = [lead.gradeInterested, lead.boardInterested, lead.subjectsInterested.length ? lead.subjectsInterested.join(', ') : null].filter(
    (p): p is string => !!p,
  );
  return parts.length ? parts.join(' · ') : null;
}

export function timeAgo(iso: string, now: number = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const mins = Math.max(0, Math.round((now - t) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}
