import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, CheckCheck, Clock, ShieldCheck, X } from 'lucide-react';
import { api } from '../../services/api';
import { getErrorMessage } from '../../services/http';
import type { AttendanceMarkEntry, AttendanceRoster, AttendanceStatus, BatchDetail } from '../../types';
import { Avatar, Button, Card, CardHeader, DateInput, EmptyState, ErrorState, Input, SkeletonList, useConfirm, useToast } from '../../ui';
import { AttendanceHistory } from './AttendanceHistory';
import { STATUS_LABEL, batchLabel } from './helpers';
import { addDays, formatYmd, todayIst } from './dates';
import { teacherKeys } from './hooks';

const STATUS_ICON: Record<AttendanceStatus, typeof Check> = { present: Check, absent: X, late: Clock, excused: ShieldCheck };
const STATUSES: readonly AttendanceStatus[] = ['present', 'absent', 'late', 'excused'];

interface Draft {
  status: AttendanceStatus | null;
  note: string;
}

export function AttendanceTab({ batch }: { batch: BatchDetail }) {
  const today = todayIst();
  const [date, setDate] = useState(today);
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(date) && date <= today;

  const q = useQuery({
    queryKey: teacherKeys.roster(batch.id, date),
    queryFn: ({ signal }) => api.attendance.roster(batch.id, date, { signal }),
    enabled: valid,
  });

  return (
    <Card flush>
      <CardHeader
        title={`Attendance · ${batchLabel(batch)}`}
        subtitle={valid ? formatYmd(date) : undefined}
        actions={
          <>
            <Button variant="secondary" size="sm" disabled={!/^\d{4}-\d{2}-\d{2}$/.test(date)} onClick={() => setDate(addDays(date, -1))} aria-label="Previous day">
              Previous day
            </Button>
            <Button variant="secondary" size="sm" disabled={!valid || date >= today} onClick={() => setDate(addDays(date, 1))} aria-label="Next day">
              Next day
            </Button>
          </>
        }
      />
      <div className="tp__toolbar" style={{ padding: '0 18px 12px' }}>
        <DateInput
          label="Date"
          value={date}
          max={today}
          onChange={(e) => setDate(e.target.value)}
          error={!valid ? 'Pick a date that is not in the future' : undefined}
          wrapperClassName="tp__date"
        />
        {date !== today && (
          <Button variant="ghost" size="sm" onClick={() => setDate(today)}>
            Back to today
          </Button>
        )}
      </div>
      {!valid ? null : q.isPending ? (
        <div style={{ padding: 18 }}>
          <SkeletonList rows={5} />
        </div>
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
      ) : q.data.roster.length === 0 ? (
        <EmptyState title="No students enrolled" description="This batch has no enrolled students yet." />
      ) : (
        <AttendanceSheet key={`${batch.id}:${date}`} batchId={batch.id} date={date} roster={q.data} />
      )}
    </Card>
  );
}

function initialDraft(roster: AttendanceRoster): Record<string, Draft> {
  const out: Record<string, Draft> = {};
  for (const r of roster.roster) out[r.studentId] = { status: r.status, note: r.note ?? '' };
  return out;
}

function AttendanceSheet({ batchId, date, roster }: { batchId: string; date: string; roster: AttendanceRoster }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Record<string, Draft>>(() => initialDraft(roster));

  const rows = roster.roster;
  const unmarked = rows.filter((r) => draft[r.studentId]?.status == null).length;
  const markedCount = rows.length - unmarked;
  const dirty = rows.some((r) => {
    const d = draft[r.studentId];
    return d.status !== r.status || d.note !== (r.note ?? '');
  });

  const save = useMutation({
    mutationFn: () => {
      const entries: AttendanceMarkEntry[] = [];
      for (const r of rows) {
        const d = draft[r.studentId];
        if (d.status === null) continue;
        const note = d.note.trim();
        entries.push({ studentId: r.studentId, status: d.status, ...(note ? { note } : {}) });
      }
      return api.attendance.mark(batchId, date, entries);
    },
    onSuccess: (res) => {
      toast.success(`Attendance saved for ${res.saved} ${res.saved === 1 ? 'student' : 'students'} on ${formatYmd(res.date)}`);
      void qc.invalidateQueries({ queryKey: teacherKeys.roster(batchId, date) });
      if (date === todayIst()) void qc.invalidateQueries({ queryKey: ['teacher', 'roster', batchId] });
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  const absentCount = rows.filter((r) => draft[r.studentId]?.status === 'absent').length;
  const confirm = useConfirm();
  const notify = useMutation({
    mutationFn: () => api.attendance.notifyAbsent(batchId, date),
    onSuccess: (r) => {
      const parts = [`${r.notified} parent${r.notified === 1 ? '' : 's'} notified`];
      if (r.alreadyNotified) parts.push(`${r.alreadyNotified} already notified`);
      if (r.skippedOptedOut) parts.push(`${r.skippedOptedOut} opted out`);
      if (r.noContact) parts.push(`${r.noContact} with no contact details`);
      if (r.failed) parts.push(`${r.failed} failed`);
      toast.success(parts.join(' · '));
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });
  const onNotify = async () => {
    const ok = await confirm({
      title: 'Notify parents of absences?',
      message: `${absentCount} absent ${absentCount === 1 ? 'student' : 'students'} on ${formatYmd(date)}. Each parent gets a WhatsApp message and an email. A parent is only notified once per day.`,
      confirmLabel: 'Send notices',
    });
    if (ok) notify.mutate();
  };

  const setStatus = (id: string, status: AttendanceStatus) => setDraft((d) => ({ ...d, [id]: { ...d[id], status } }));
  const setNote = (id: string, note: string) => setDraft((d) => ({ ...d, [id]: { ...d[id], note } }));
  const markAllPresent = () =>
    setDraft((d) => Object.fromEntries(Object.entries(d).map(([id, v]) => [id, { ...v, status: 'present' as const }])));

  return (
    <>
      <div className="tp__toolbar" style={{ padding: '0 18px 12px' }}>
        <Button variant="secondary" size="sm" icon={<CheckCheck size={14} aria-hidden="true" />} onClick={markAllPresent}>
          Mark all present
        </Button>
      </div>
      <ul className="tp__list" aria-label="Student attendance" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {rows.map((r) => {
          const d = draft[r.studentId];
          return (
            <li key={r.studentId} className="tp__row">
              <div className="tp__student">
                <Avatar name={r.fullName} size={30} />
                <span>{r.fullName}</span>
              </div>
              <div className="tp__seg" role="group" aria-label={`Attendance for ${r.fullName}`}>
                {STATUSES.map((s) => {
                  const Icon = STATUS_ICON[s];
                  return (
                    <button
                      key={s}
                      type="button"
                      className={`is-${s}`}
                      aria-pressed={d.status === s}
                      aria-label={`Mark ${r.fullName} ${s}`}
                      onClick={() => setStatus(r.studentId, s)}
                    >
                      <Icon size={12} aria-hidden="true" />
                      {STATUS_LABEL[s]}
                    </button>
                  );
                })}
              </div>
              <Input
                label={`Note for ${r.fullName}`}
                hideLabel
                className="tp__note"
                placeholder="Note (optional)"
                maxLength={500}
                value={d.note}
                onChange={(e) => setNote(r.studentId, e.target.value)}
              />
              <AttendanceHistory studentId={r.studentId} name={r.fullName} />
            </li>
          );
        })}
      </ul>
      <div className="tp__savebar">
        {unmarked > 0 ? (
          <span className="tp__savebar-msg tp__savebar-msg--warn" role="status">
            <AlertTriangle size={14} aria-hidden="true" />
            {unmarked} {unmarked === 1 ? 'student is' : 'students are'} not marked yet
          </span>
        ) : null}
        {!dirty && markedCount > 0 && (
          <span className="tp__savebar-msg tp__savebar-msg--ok" role="status">
            <Check size={14} aria-hidden="true" />
            All changes saved
          </span>
        )}
        {dirty && <span className="tp__savebar-msg">Unsaved changes</span>}
        {!dirty && absentCount > 0 && (
          <Button variant="secondary" loading={notify.isPending} disabled={notify.isPending} onClick={() => void onNotify()}>
            Notify parents of absences ({absentCount})
          </Button>
        )}
        <Button
          style={{ marginLeft: 'auto' }}
          loading={save.isPending}
          disabled={save.isPending || !dirty || markedCount === 0}
          onClick={() => save.mutate()}
        >
          Save attendance
        </Button>
      </div>
    </>
  );
}
