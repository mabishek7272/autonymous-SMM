import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cx } from './cx';

export interface TabOption<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
  /** Small count pill (real numbers only). */
  count?: number;
}

interface TabsProps<T extends string> {
  options: readonly TabOption<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  variant?: 'segmented' | 'underline';
  className?: string;
}

/** Accessible tablist with roving arrow-key navigation. Pair panels with role="tabpanel" in the caller. */
export function Tabs<T extends string>({ options, value, onChange, ariaLabel, variant = 'segmented', className }: TabsProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const idx = options.findIndex((o) => o.value === value);
    let next = idx;
    if (e.key === 'ArrowRight') next = (idx + 1) % options.length;
    else if (e.key === 'ArrowLeft') next = (idx - 1 + options.length) % options.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = options.length - 1;
    else return;
    e.preventDefault();
    onChange(options[next].value);
    refs.current[next]?.focus();
  };

  return (
    <div role="tablist" aria-label={ariaLabel} className={cx('ek-tabs', variant === 'underline' && 'ek-tabs--underline', className)} onKeyDown={onKeyDown}>
      {options.map((o, i) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            className="ek-tab"
            onClick={() => onChange(o.value)}
          >
            {o.icon}
            {o.label}
            {o.count !== undefined && <span className="ek-tab__count">{o.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** Pill-style single-choice control (provider switch etc.): same component, segmented look. */
export const SegmentedControl = Tabs;
