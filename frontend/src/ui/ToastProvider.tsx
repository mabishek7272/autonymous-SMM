import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, Sparkles, X } from 'lucide-react';
import { getErrorMessage } from '../services/http';
import { cx } from './cx';
import { ToastContext, type ToastApi, type ToastTone } from './toast-context';

interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
}

const DURATION: Record<ToastTone, number> = { success: 2600, info: 2600, error: 6000 };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const t = timers.current.get(id);
    if (t) clearTimeout(t);
    timers.current.delete(id);
    setItems((list) => list.filter((i) => i.id !== id));
  }, []);

  const push = useCallback(
    (tone: ToastTone, message: string) => {
      const id = nextId.current++;
      setItems((list) => [...list.slice(-3), { id, tone, message }]);
      timers.current.set(id, setTimeout(() => dismiss(id), DURATION[tone]));
    },
    [dismiss],
  );

  useEffect(() => {
    const map = timers.current;
    return () => {
      map.forEach(clearTimeout);
      map.clear();
    };
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      success: (m) => push('success', m),
      error: (m) => push('error', m),
      info: (m) => push('info', m),
      fromError: (err, prefix) => {
        const msg = getErrorMessage(err);
        push('error', prefix ? `${prefix}: ${msg}` : msg);
      },
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="ek-toasts">
        {items.map((t) => (
          <div key={t.id} className={cx('ek-toast', t.tone === 'error' && 'ek-toast--error')} role={t.tone === 'error' ? 'alert' : 'status'}>
            <span className="ek-toast__icon">{t.tone === 'error' ? <AlertCircle size={14} aria-hidden="true" /> : <Sparkles size={14} aria-hidden="true" />}</span>
            {t.message}
            <button type="button" className="ek-toast__close" aria-label="Dismiss notification" onClick={() => dismiss(t.id)}>
              <X size={13} aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
