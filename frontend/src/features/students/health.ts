import type { HealthStatus, StudentHealthEntry } from '../../types';
import type { Tone } from '../../ui/tone';

/** Mirrors backend HEALTH_THRESHOLDS (academic-monitoring.service): GREEN >= 70, YELLOW 50-69, RED < 50. */
export const GREEN_MIN = 70;
export const YELLOW_MIN = 50;

export type HealthFilter = 'all' | 'GREEN' | 'YELLOW' | 'RED';

export const LEVEL_LABEL: Record<HealthStatus, string> = {
  GREEN: 'Healthy',
  YELLOW: 'At-Risk',
  RED: 'Critical',
  UNKNOWN: 'No data',
};

/** Tone for a 0-100 percentage using the backend bands. */
export function percentTone(value: number | null): Tone {
  if (value === null) return 'neutral';
  if (value >= GREEN_MIN) return 'success';
  if (value >= YELLOW_MIN) return 'warning';
  return 'danger';
}

export interface StudentFlag {
  id: string;
  text: string;
  tone: 'warning' | 'danger';
}

/** AI flags derived only from the fields the health endpoint returns. */
export function deriveFlags(s: StudentHealthEntry): StudentFlag[] {
  const flags: StudentFlag[] = [];
  if (s.attendancePercentage !== null && s.attendancePercentage < GREEN_MIN) {
    flags.push({
      id: 'attendance',
      text: `Attendance ${Math.round(s.attendancePercentage)}% in last ${s.attendanceWindowDays} days (below ${GREEN_MIN}%)`,
      tone: s.attendancePercentage < YELLOW_MIN ? 'danger' : 'warning',
    });
  }
  for (const sub of s.subjectAverages) {
    if (sub.averagePercentage < YELLOW_MIN) {
      flags.push({ id: `subject-${sub.subject}`, text: `Below ${YELLOW_MIN}% in ${sub.subject} (${sub.averagePercentage}%)`, tone: 'danger' });
    }
  }
  if (s.lastAssessment && s.lastAssessment.percentage < YELLOW_MIN) {
    flags.push({
      id: 'last-assessment',
      text: `Latest assessment scored ${s.lastAssessment.percentage}%`,
      tone: 'warning',
    });
  }
  return flags;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

export function lastAssessmentText(s: StudentHealthEntry): string {
  const a = s.lastAssessment;
  if (!a) return 'No assessments recorded yet';
  const date = formatDate(a.testDate);
  return `Last assessment · ${a.subject ?? 'Test'} ${a.percentage}%${date ? ` · ${date}` : ''}`;
}

export function toNumber(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
