import { clamp, toneColor, type Tone } from './tone';

interface ProgressBarProps {
  value: number | null;
  max?: number;
  label: string;
  tone?: Tone;
  /** Shows "value%" text (never colour alone). */
  showValue?: boolean;
}

export function ProgressBar({ value, max = 100, label, tone = 'primary', showValue = true }: ProgressBarProps) {
  const pct = value === null ? 0 : clamp((value / max) * 100, 0, 100);
  return (
    <div className="ek-progress">
      <div className="ek-progress__head">
        <span>{label}</span>
        {showValue && <span className="ek-progress__value">{value === null ? '—' : `${Math.round(pct)}%`}</span>}
      </div>
      <div
        className="ek-progress__track"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value === null ? undefined : value}
        aria-valuetext={value === null ? 'No data' : `${Math.round(pct)}%`}
      >
        <div className="ek-progress__bar" style={{ width: `${pct}%`, background: toneColor(tone) }} />
      </div>
    </div>
  );
}

interface RingGaugeProps {
  /** 0-100; null renders an empty ring with an em dash (no data). */
  value: number | null;
  label: string;
  caption?: string;
  size?: number;
  stroke?: number;
  tone?: Tone;
}

export function RingGauge({ value, label, caption, size = 96, stroke = 9, tone = 'primary' }: RingGaugeProps) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = value === null ? 0 : clamp(value, 0, 100);
  return (
    <div className="ek-ring" style={{ width: size, height: size }} role="img" aria-label={value === null ? `${label}: no data` : `${label}: ${Math.round(pct)}%`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#EEF2F6" strokeWidth={stroke} />
        {value !== null && (
          <circle
            data-testid="ring-arc"
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={toneColor(tone)}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={c}
            strokeDashoffset={c * (1 - pct / 100)}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        )}
      </svg>
      <div className="ek-ring__label" aria-hidden="true">
        <span className="ek-ring__value">{value === null ? '—' : Math.round(pct)}</span>
        {caption && <span className="ek-ring__caption">{caption}</span>}
      </div>
    </div>
  );
}
