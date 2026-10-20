export type Tone = 'primary' | 'warm' | 'success' | 'warning' | 'danger' | 'neutral';

const COLORS: Record<Tone, string> = {
  primary: '#7C3AED',
  warm: '#F97316',
  success: '#059669',
  warning: '#F59E0B',
  danger: '#DC2626',
  neutral: '#94A3B8',
};

export function toneColor(tone: Tone): string {
  return COLORS[tone];
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** Health band to tone (GREEN/YELLOW/RED/UNKNOWN from the backend). */
export function healthTone(health: string): Tone {
  if (health === 'GREEN') return 'success';
  if (health === 'YELLOW') return 'warning';
  if (health === 'RED') return 'danger';
  return 'neutral';
}
