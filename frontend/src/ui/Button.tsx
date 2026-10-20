import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { cx } from './cx';
import { Spinner } from './Spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'warm' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** sm 26px, md 32px, lg 40px; default is the 34px prototype action button. */
  size?: ButtonSize;
  /** Shows a spinner and disables the button while a request is pending. */
  loading?: boolean;
  icon?: ReactNode;
  block?: boolean;
  /** Square icon-only button: always pass aria-label. */
  iconOnly?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

export function Button({
  variant = 'primary',
  size,
  loading = false,
  icon,
  block,
  iconOnly,
  disabled,
  className,
  children,
  type = 'button',
  ref,
  ...rest
}: ButtonProps) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(
        'ek-btn',
        `ek-btn--${variant}`,
        size && `ek-btn--${size}`,
        block && 'ek-btn--block',
        iconOnly && 'ek-btn--icon',
        className,
      )}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner size={13} /> : icon}
      {children}
    </button>
  );
}
