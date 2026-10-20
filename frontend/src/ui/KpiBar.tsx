import type { ReactNode } from 'react';
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import { cx } from './cx';
import { Skeleton } from './Skeleton';

export interface KpiItem {
  label: string;
  /** Real value from the backend, already formatted. Use "—" when the backend has no value. */
  value: ReactNode;
  /** Only pass when the backend supplies a real comparison. */
  delta?: { text: string; direction: 'up' | 'down' | 'flat' };
  sub?: string;
}

interface KpiBarProps {
  items: readonly KpiItem[];
  loading?: boolean;
  /** Placeholder count while loading and `items` is empty. */
  loadingCount?: number;
}

const DELTA_ICON = { up: ArrowUpRight, down: ArrowDownRight, flat: Minus } as const;

/** The prototype's KPI stats bar: a row of equal cards fed with real numbers by the view. */
export function KpiBar({ items, loading, loadingCount = 5 }: KpiBarProps) {
  if (loading && items.length === 0) {
    return (
      <div className="ek-kpis" style={{ gridTemplateColumns: `repeat(${loadingCount}, minmax(0, 1fr))` }} role="status" aria-label="Loading metrics" aria-busy="true">
        {Array.from({ length: loadingCount }, (_, i) => (
          <div key={i} className="ek-kpi">
            <Skeleton width="50%" height={11} />
            <Skeleton width="40%" height={30} />
            <Skeleton width="60%" height={11} />
          </div>
        ))}
      </div>
    );
  }
  if (items.length === 0) return null;
  return (
    <section className="ek-kpis" style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }} aria-label="Key metrics">
      {items.map((k) => {
        const Icon = k.delta ? DELTA_ICON[k.delta.direction] : null;
        return (
          <div key={k.label} className="ek-kpi">
            <span className="ek-kpi__label">{k.label}</span>
            <div className="ek-kpi__row">
              <span className="ek-kpi__value">{k.value}</span>
              {k.delta && Icon && (
                <span className={cx('ek-kpi__delta', `ek-kpi__delta--${k.delta.direction}`)}>
                  <Icon size={12} aria-hidden="true" />
                  {k.delta.text}
                </span>
              )}
            </div>
            {k.sub && <span className="ek-kpi__sub">{k.sub}</span>}
          </div>
        );
      })}
    </section>
  );
}
