import type { BadgeTone } from '../../ui';

const OUTCOME: Record<string, { label: string; tone: BadgeTone }> = {
  demo_booked: { label: 'Demo booked', tone: 'success' },
  callback_requested: { label: 'Callback requested', tone: 'primary' },
  not_interested: { label: 'Not interested', tone: 'danger' },
  info_only: { label: 'Info only', tone: 'neutral' },
  dropped: { label: 'Dropped', tone: 'warning' },
  unknown: { label: 'Unknown', tone: 'neutral' },
};

export function outcomeBadge(outcome: string | null): { label: string; tone: BadgeTone } {
  if (!outcome) return { label: 'No outcome', tone: 'neutral' };
  return OUTCOME[outcome] ?? { label: outcome.replace(/_/g, ' '), tone: 'neutral' };
}

export function formatDuration(sec: number | null): string {
  if (sec === null || sec === undefined) return 'Duration unknown';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m ? `${m}m ${s}s` : `${s}s`;
}
