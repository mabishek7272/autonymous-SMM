import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from './cx';

export type BadgeTone = 'neutral' | 'primary' | 'warm' | 'success' | 'warning' | 'danger' | 'info';

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  /** Leading icon; pair colour with an icon or text so colour is never the only signal. */
  icon?: ReactNode;
  uppercase?: boolean;
  mono?: boolean;
}

export function Badge({ tone = 'neutral', icon, uppercase, mono, className, children, ...rest }: BadgeProps) {
  return (
    <span className={cx('ek-badge', `ek-badge--${tone}`, uppercase && 'ek-badge--upper', mono && 'ek-badge--mono', className)} {...rest}>
      {icon}
      {children}
    </span>
  );
}

/** Alias: the prototype calls these pills. */
export const Pill = Badge;
