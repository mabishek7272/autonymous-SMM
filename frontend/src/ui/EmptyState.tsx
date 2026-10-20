import type { ReactNode } from 'react';
import { Button } from './Button';
import { cx } from './cx';

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void; loading?: boolean } | ReactNode;
  className?: string;
}

function isActionConfig(a: EmptyStateProps['action']): a is { label: string; onClick: () => void; loading?: boolean } {
  return typeof a === 'object' && a !== null && 'label' in a && 'onClick' in a;
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cx('ek-state', 'ek-state--empty', className)}>
      {icon && <div className="ek-state__icon">{icon}</div>}
      <div className="ek-state__title">{title}</div>
      {description && <div className="ek-state__desc">{description}</div>}
      {action && (
        <div className="ek-state__action">
          {isActionConfig(action) ? (
            <Button variant="secondary" size="md" onClick={action.onClick} loading={action.loading}>
              {action.label}
            </Button>
          ) : (
            action
          )}
        </div>
      )}
    </div>
  );
}
