import { createContext, useContext } from 'react';

export type ToastTone = 'success' | 'error' | 'info';

export interface ToastApi {
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
  /** Error toast with the real server message, optionally prefixed ("Could not save: ..."). */
  fromError: (err: unknown, prefix?: string) => void;
}

export const ToastContext = createContext<ToastApi | null>(null);

/** Global toast system. Requires <ToastProvider> (mounted in App). */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}
