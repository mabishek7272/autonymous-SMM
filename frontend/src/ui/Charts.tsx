import { toneColor, type Tone } from './tone';

export interface DonutSegment {
  label: string;
  value: number;
  color?: string;
  tone?: Tone;
}

interface DonutChartProps {
  segments: readonly DonutSegment[];
  label: string;
  size?: number;
  stroke?: number;
  centerValue?: string | number;
  centerCaption?: string;
}

const PALETTE = ['#7C3AED', '#F97316', '#059669', '#F59E0B', '#2563EB', '#DC2626'];

/** Donut with a text legend (values are always printed, so colour is never the only signal). */
export function DonutChart({ segments, label, size = 120, stroke = 16, centerValue, centerCaption }: DonutChartProps) {
  const total = segments.reduce((a, s) => a + s.value, 0);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div className="ek-donut">
      <div style={{ position: 'relative', width: size, height: size, flex: 'none' }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${label}: ${total === 0 ? 'no data' : segments.map((s) => `${s.label} ${s.value}`).join(', ')}`}>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#EEF2F6" strokeWidth={stroke} />
          {total > 0 &&
            segments.map((s, i) => {
              const len = (s.value / total) * c;
              const el = (
                <circle
                  key={s.label}
                  cx={size / 2}
                  cy={size / 2}
                  r={r}
                  fill="none"
                  stroke={s.color ?? (s.tone ? toneColor(s.tone) : PALETTE[i % PALETTE.length])}
                  strokeWidth={stroke}
                  strokeDasharray={`${len} ${c - len}`}
                  strokeDashoffset={-offset}
                  transform={`rotate(-90 ${size / 2} ${size / 2})`}
                />
              );
              offset += len;
              return el;
            })}
        </svg>
        <div className="ek-ring__label" style={{ inset: 0, justifyContent: 'center', margin: 'auto' }} aria-hidden="true">
          <span className="ek-ring__value">{centerValue ?? total}</span>
          {centerCaption && <span className="ek-ring__caption">{centerCaption}</span>}
        </div>
      </div>
      <ul className="ek-legend">
        {segments.map((s, i) => (
          <li key={s.label}>
            <span className="ek-legend__dot" style={{ background: s.color ?? (s.tone ? toneColor(s.tone) : PALETTE[i % PALETTE.length]) }} aria-hidden="true" />
            {s.label}
            <span className="ek-legend__value">{s.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface BarListItem {
  label: string;
  value: number;
  /** Text for the value column; defaults to the number. */
  display?: string;
  color?: string;
  tone?: Tone;
}

interface BarListProps {
  items: readonly BarListItem[];
  /** Scale maximum; defaults to the largest value. */
  max?: number;
  ariaLabel: string;
}

export function BarList({ items, max, ariaLabel }: BarListProps) {
  const scale = max ?? Math.max(1, ...items.map((i) => i.value));
  return (
    <ul className="ek-barlist" aria-label={ariaLabel}>
      {items.map((item) => (
        <li key={item.label} className="ek-barlist__row">
          <div className="ek-barlist__head">
            <span>{item.label}</span>
            <span className="ek-barlist__value">{item.display ?? item.value}</span>
          </div>
          <div className="ek-barlist__track" aria-hidden="true">
            <div
              className="ek-barlist__bar"
              style={{ width: `${Math.min(100, Math.max(0, (item.value / scale) * 100))}%`, background: item.color ?? (item.tone ? toneColor(item.tone) : undefined) }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
