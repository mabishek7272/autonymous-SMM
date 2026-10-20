import { useCallback, useRef, useState, type ReactNode } from 'react';
import { Button } from './Button';
import { Modal } from './Modal';
import { ConfirmContext, type ConfirmFn, type ConfirmOptions } from './confirm-context';

interface ConfirmDialogProps extends ConfirmOptions {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  loading?: boolean;
}

/** Presentational confirm dialog; focus starts on the cancel button so Enter never confirms by accident. */
export function ConfirmDialog({ open, title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', tone = 'primary', onConfirm, onCancel, loading }: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      width={440}
      initialFocus={cancelRef}
      footer={
        <>
          <Button ref={cancelRef} variant="secondary" onClick={onCancel} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p style={{ fontSize: 13.5, color: 'var(--text-body)', lineHeight: 1.55 }}>{message}</p>
    </Modal>
  );
}

interface Pending {
  options: ConfirmOptions;
  resolve: (ok: boolean) => void;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);

  const confirm = useCallback<ConfirmFn>(
    (options) =>
      new Promise<boolean>((resolve) => {
        setPending({ options, resolve });
      }),
    [],
  );

  const settle = (ok: boolean) => {
    pending?.resolve(ok);
    setPending(null);
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && <ConfirmDialog open {...pending.options} onConfirm={() => settle(true)} onCancel={() => settle(false)} />}
    </ConfirmContext.Provider>
  );
}
