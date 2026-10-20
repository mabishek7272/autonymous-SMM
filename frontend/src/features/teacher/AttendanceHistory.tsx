import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { History } from 'lucide-react';
import { api } from '../../services/api';
import { getErrorMessage } from '../../services/http';
import { Badge, Button, Spinner, type BadgeTone } from '../../ui';
import type { AttendanceStatus } from '../../types';
import { addDays, formatYmd, todayIst } from './dates';
import { STATUS_LABEL } from './helpers';
import { teacherKeys } from './hooks';

const STATUS_TONE: Record<AttendanceStatus, BadgeTone> = {
  present: 'success',
  absent: 'danger',
  late: 'warning',
  excused: 'info',
};

const WINDOW_DAYS = 30;

/** Per-student attendance percentage over the last 30 days, loaded when opened. */
export function AttendanceHistory({ studentId, name }: { studentId: string; name: string }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const to = todayIst();
  const from = addDays(to, -(WINDOW_DAYS - 1));

  const q = useQuery({
    queryKey: teacherKeys.history(studentId, from, to),
    queryFn: ({ signal }) => api.attendance.studentHistory(studentId, from, to, { signal }),
    enabled: open,
  });

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  return (
    <div className="tp__pop-wrap" ref={wrapRef}>
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        aria-label={`Attendance history for ${name}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
      >
        <History size={14} aria-hidden="true" />
      </Button>
      {open && (
        <div className="tp__pop" role="dialog" aria-label={`Attendance history for ${name}`}>
          <h4>{name}</h4>
          {q.isPending && <Spinner label="Loading history" />}
          {q.isError && (
            <div role="alert">
              {getErrorMessage(q.error)}{' '}
              <Button variant="secondary" size="sm" onClick={() => void q.refetch()}>
                Retry
              </Button>
            </div>
          )}
          {q.data && (
            <>
              <div>
                Last {WINDOW_DAYS} days:{' '}
                <strong>{q.data.percentage === null ? 'no marks yet' : `${q.data.percentage}% attendance`}</strong>
              </div>
              <div style={{ color: 'var(--text-muted)' }}>
                {q.data.presentDays} present or late of {q.data.markedDays} marked days
              </div>
              {q.data.history.length > 0 && (
                <ul aria-label="Recent days">
                  {q.data.history.slice(0, 6).map((h) => (
                    <li key={h.id}>
                      <span>{formatYmd(h.date.slice(0, 10))}</span>
                      <Badge tone={STATUS_TONE[h.status]}>{STATUS_LABEL[h.status]}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
