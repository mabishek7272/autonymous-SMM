import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { Button } from './Button';
import { cx } from './cx';
import { useFocusTrap } from './useFocusTrap';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: ReactNode;
  /** Leading element in the header (avatar, icon tile). */
  icon?: ReactNode;
  /** Extra header content next to the title (badges). */
  headerExtra?: ReactNode;
  children: ReactNode;
  /** Sticky footer, typically action buttons. */
  footer?: ReactNode;
  width?: number;
  /** Set false for dialogs that must not be dismissed by clicking outside (unsaved forms). */
  closeOnBackdrop?: boolean;
  initialFocus?: RefObject<HTMLElement | null>;
  className?: string;
}

/**
 * Accessible modal: portal, role=dialog + aria-modal, focus trap, Esc and backdrop-click to close,
 * body scroll lock, focus restored to the opener.
 */
export function Modal({
  open,
  onClose,
  title,
  subtitle,
  icon,
  headerExtra,
  children,
  footer,
  width,
  closeOnBackdrop = true,
  initialFocus,
  className,
}: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useFocusTrap(ref, open, { onEscape: onClose, initialFocus, preferWithin: '.ek-modal__body' });

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      className="ek-modal-backdrop"
      onMouseDown={(e) => {
        if (closeOnBackdrop && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className={cx('ek-modal', className)}
        style={width ? { width } : undefined}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="ek-modal__header">
          {icon}
          <div className="ek-modal__titles">
            <h2 id={titleId} className="ek-modal__title">
              {title}
            </h2>
            {subtitle && <span className="ek-modal__subtitle">{subtitle}</span>}
          </div>
          {headerExtra}
          <Button variant="secondary" size="md" iconOnly className="ek-modal__close" aria-label="Close dialog" onClick={onClose}>
            <X size={15} aria-hidden="true" />
          </Button>
        </div>
        <div className="ek-modal__body">{children}</div>
        {footer && <div className="ek-modal__footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
