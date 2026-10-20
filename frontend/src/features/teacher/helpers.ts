import type { AttendanceStatus, BatchDetail } from '../../types';

export function batchLabel(b: BatchDetail): string {
  return b.batchName?.trim() || b.course.courseName;
}

export const STATUS_LABEL: Record<AttendanceStatus, string> = {
  present: 'Present',
  absent: 'Absent',
  late: 'Late',
  excused: 'Excused',
};

export function validateMeetingUrl(raw: string): string | undefined {
  const v = raw.trim();
  if (!v) return 'Meeting link is required';
  try {
    const u = new URL(v);
    if (u.protocol !== 'https:') return 'Meeting link must start with https://';
  } catch {
    return 'Enter a valid link, e.g. https://teams.microsoft.com/l/meetup-join/...';
  }
  if (v.length > 2000) return 'Link is too long';
  return undefined;
}
