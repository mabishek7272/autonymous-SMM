import { AlertTriangle, RefreshCw } from 'lucide-react';
import { getErrorMessage } from '../services/http';
import { Button } from './Button';
import { cx } from './cx';

interface ErrorStateProps {
  /** The thrown error (its message, usually the server's, is displayed). */
  error?: unknown;
  /** Overrides the message derived from `error`. */
  message?: string;
  title?: string;
  onRetry?: () => void;
  retrying?: boolean;
  className?: string;
}

export function ErrorState({ error, message, title = 'Could not load this data', onRetry, retrying, className }: ErrorStateProps) {
  return (
    <div className={cx('ek-state', 'ek-state--error', className)} role="alert">
      <div className="ek-state__icon">
        <AlertTriangle size={22} aria-hidden="true" />
      </div>
      <div className="ek-state__title">{title}</div>
      <div className="ek-state__desc">{message ?? getErrorMessage(error)}</div>
      {onRetry && (
        <div className="ek-state__action">
          <Button variant="secondary" size="md" icon={<RefreshCw size={13} aria-hidden="true" />} onClick={onRetry} loading={retrying}>
            Retry
          </Button>
        </div>
      )}
    </div>
  );
}
