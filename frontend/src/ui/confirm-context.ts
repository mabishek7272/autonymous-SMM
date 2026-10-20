import { createContext, useContext } from 'react';

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 'danger' for destructive actions (red confirm button). */
  tone?: 'primary' | 'danger';
}

export type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

export const ConfirmContext = createContext<ConfirmFn | null>(null);

/**
 * Promise-based confirm dialog helper:
 *   const confirm = useConfirm();
 *   if (!(await confirm({ title: 'Delete rule?', message: '...', tone: 'danger' }))) return;
 */
export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used inside <ConfirmProvider>');
  return ctx;
}
