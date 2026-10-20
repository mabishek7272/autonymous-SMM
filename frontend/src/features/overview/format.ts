const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });

export function formatInr(amount: number): string {
  return inr.format(amount);
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat('en-IN').format(n);
}

export function formatPercent(n: number | null | undefined, digits = 0): string {
  return n === null || n === undefined ? '—' : `${n.toFixed(digits)}%`;
}

/** "just now", "5m ago", "3h ago", "2d ago", then a short date. */
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const sec = Math.max(0, Math.round((now - t) / 1000));
  if (sec < 45) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(t).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** "sent_whatsapp_message" / "lead.mark_lost" -> "Sent whatsapp message". */
export function humanizeAction(action: string | null | undefined): string {
  if (!action) return 'Action';
  const s = action.replace(/[._]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** First non-empty string among well-known keys of a free-form payload (rendered defensively). */
export function payloadText(payload: Record<string, unknown> | null | undefined, keys: readonly string[] = ['summary', 'message', 'text', 'reason', 'error']): string | null {
  if (!payload) return null;
  for (const k of keys) {
    const v = payload[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}
