import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from './cx';

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Removes inner padding (for tables / lists that manage their own). */
  flush?: boolean;
  hoverable?: boolean;
}

export function Card({ flush, hoverable, className, ...rest }: CardProps) {
  return <div className={cx('ek-card', flush && 'ek-card--flush', hoverable && 'ek-card--hover', className)} {...rest} />;
}

interface CardHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}

export function CardHeader({ title, subtitle, actions }: CardHeaderProps) {
  return (
    <div className="ek-card__header">
      <div style={{ minWidth: 0 }}>
        <div className="ek-card__title">{title}</div>
        {subtitle && <div className="ek-card__subtitle">{subtitle}</div>}
      </div>
      {actions && <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>{actions}</div>}
    </div>
  );
}
