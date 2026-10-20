import { cx } from './cx';

interface SpinnerProps {
  size?: number;
  /** Accessible name; omit when the spinner sits inside a button that already has a label. */
  label?: string;
  className?: string;
}

export function Spinner({ size = 16, label, className }: SpinnerProps) {
  return (
    <span
      className={cx('ek-spinner', className)}
      style={{ width: size, height: size }}
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}
