import { useId, useState, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { AlertCircle, Eye, EyeOff } from 'lucide-react';
import { Button } from './Button';
import { cx } from './cx';

interface FieldChrome {
  label: string;
  error?: string;
  hint?: string;
  /** Visually hide the label (it is still read by screen readers). */
  hideLabel?: boolean;
}

interface FieldShellProps extends FieldChrome {
  id: string;
  required?: boolean;
  children: ReactNode;
  className?: string;
}

function FieldShell({ id, label, error, hint, hideLabel, required, children, className }: FieldShellProps) {
  return (
    <div className={cx('ek-field', className)}>
      <label htmlFor={id} className={cx('ek-label', hideLabel && 'ek-sr-only')}>
        {label}
        {required && (
          <span className="ek-label__req" aria-hidden="true">
            *
          </span>
        )}
      </label>
      {children}
      {hint && !error && (
        <span id={`${id}-hint`} className="ek-hint">
          {hint}
        </span>
      )}
      {error && (
        <span id={`${id}-err`} className="ek-error" role="alert">
          <AlertCircle size={12} aria-hidden="true" />
          {error}
        </span>
      )}
    </div>
  );
}

function describedBy(id: string, error?: string, hint?: string): string | undefined {
  if (error) return `${id}-err`;
  if (hint) return `${id}-hint`;
  return undefined;
}

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'>, FieldChrome {
  id?: string;
  /** Icon rendered inside the input on the left (decorative). */
  startIcon?: ReactNode;
  wrapperClassName?: string;
}

export function Input({ label, error, hint, hideLabel, id: idProp, startIcon, className, wrapperClassName, required, type, ...rest }: InputProps) {
  const auto = useId();
  const id = idProp ?? auto;
  const [reveal, setReveal] = useState(false);
  const isPassword = type === 'password';
  return (
    <FieldShell id={id} label={label} error={error} hint={hint} hideLabel={hideLabel} required={required} className={wrapperClassName}>
      <div className="ek-input-wrap">
        {startIcon && <span className="ek-input-wrap__start">{startIcon}</span>}
        <input
          id={id}
          type={isPassword && reveal ? 'text' : type}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(id, error, hint)}
          className={cx('ek-control', !!startIcon && 'ek-control--with-start', isPassword && 'ek-control--with-end', className)}
          {...rest}
        />
        {isPassword && (
          <span className="ek-input-wrap__end">
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              aria-label={reveal ? 'Hide password' : 'Show password'}
              aria-pressed={reveal}
              onClick={() => setReveal((v) => !v)}
            >
              {reveal ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
            </Button>
          </span>
        )}
      </div>
    </FieldShell>
  );
}

/** Native date input (YYYY-MM-DD value), styled as an Input. */
export function DateInput(props: Omit<InputProps, 'type'>) {
  return <Input {...props} type="date" />;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'>, FieldChrome {
  id?: string;
  options?: readonly { value: string; label: string; disabled?: boolean }[];
  /** Renders a disabled empty first option with this text. */
  placeholder?: string;
  wrapperClassName?: string;
}

export function Select({ label, error, hint, hideLabel, id: idProp, options, placeholder, children, className, wrapperClassName, required, ...rest }: SelectProps) {
  const auto = useId();
  const id = idProp ?? auto;
  return (
    <FieldShell id={id} label={label} error={error} hint={hint} hideLabel={hideLabel} required={required} className={wrapperClassName}>
      <select
        id={id}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, error, hint)}
        className={cx('ek-control', className)}
        {...rest}
      >
        {placeholder && <option value="">{placeholder}</option>}
        {options?.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
        {children}
      </select>
    </FieldShell>
  );
}

export interface TextareaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'>, FieldChrome {
  id?: string;
  wrapperClassName?: string;
}

export function Textarea({ label, error, hint, hideLabel, id: idProp, className, wrapperClassName, required, ...rest }: TextareaProps) {
  const auto = useId();
  const id = idProp ?? auto;
  return (
    <FieldShell id={id} label={label} error={error} hint={hint} hideLabel={hideLabel} required={required} className={wrapperClassName}>
      <textarea
        id={id}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, error, hint)}
        className={cx('ek-control', className)}
        {...rest}
      />
    </FieldShell>
  );
}
