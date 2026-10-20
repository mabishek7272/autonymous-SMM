import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Button } from './Button';
import { cx } from './cx';

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Next to the title (e.g. the live indicator). */
  titleExtra?: ReactNode;
  /** Filter pills etc. under the title bar. */
  headerContent?: ReactNode;
  children: ReactNode;
  width?: number;
  className?: string;
}

/**
 * Non-modal side panel docked under the header (activity stream). Closed drawers are inert so their
 * contents cannot be tabbed into; Esc closes while focus is inside.
 */
export function Drawer({ open, onClose, title, titleExtra, headerContent, children, width, className }: DrawerProps) {
  const titleId = useId();
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.inert = !open;
  }, [open]);

  return (
    <aside
      ref={ref}
      className={cx('ek-drawer', open && 'ek-drawer--open', className)}
      style={width ? { width } : undefined}
      aria-labelledby={titleId}
      aria-hidden={!open}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <div className="ek-drawer__header">
        <div className="ek-drawer__titlebar">
          <h2 id={titleId} className="ek-drawer__title">
            {title}
          </h2>
          {titleExtra}
          <Button variant="secondary" size="sm" iconOnly className="ek-drawer__close" aria-label="Close panel" onClick={onClose}>
            <X size={14} aria-hidden="true" />
          </Button>
        </div>
        {headerContent}
      </div>
      <div className="ek-drawer__body">{children}</div>
    </aside>
  );
}
