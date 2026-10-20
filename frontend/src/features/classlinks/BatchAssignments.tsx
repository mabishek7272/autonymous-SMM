import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/useAuth';
import { CalendarClock, Plus, X } from 'lucide-react';
import { api, type ScheduleSlotInput } from '../../services/api';
import { getErrorMessage } from '../../services/http';
import type { BatchDetail } from '../../types';
import { Button, Card, EmptyState, ErrorState, Input, Select, SkeletonList, useToast } from '../../ui';
import { classLinkKeys, useBatchesForLinks, useClassLinks } from './hooks';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ORDER = [1, 2, 3, 4, 5, 6, 0]; // Monday first

type Slot = { dayOfWeek: number; startTime: string; durationMinutes: number; classLinkId: string | null };

const toSlots = (b: BatchDetail): Slot[] =>
  b.schedules.map((s) => ({ dayOfWeek: s.dayOfWeek, startTime: s.startTime, durationMinutes: s.durationMinutes, classLinkId: s.classLinkId ?? null }));

const sameSlots = (a: Slot[], b: Slot[]) => JSON.stringify(a) === JSON.stringify(b);

const sortSlots = (s: Slot[]) =>
  [...s].sort((x, y) => ORDER.indexOf(x.dayOfWeek) - ORDER.indexOf(y.dayOfWeek) || x.startTime.localeCompare(y.startTime));

export function BatchAssignments() {
  const batchesQ = useBatchesForLinks();
  const linksQ = useClassLinks();
  const { hasPermission } = useAuth();
  // Only users who manage accounts can list teachers (superadmin / admin); others just see the assigned name
  const canPickTeacher = hasPermission('users:manage');
  const usersQ = useQuery({ queryKey: ['users'], queryFn: ({ signal }) => api.users.list({ signal }), enabled: canPickTeacher });
  const teachers = (usersQ.data?.data ?? []).filter((u) => u.role === 'teacher' && u.isActive);

  if (batchesQ.isPending || linksQ.isPending) return <SkeletonList rows={4} />;
  if (batchesQ.isError) return <ErrorState error={batchesQ.error} onRetry={() => void batchesQ.refetch()} retrying={batchesQ.isFetching} />;
  if (linksQ.isError) return <ErrorState error={linksQ.error} onRetry={() => void linksQ.refetch()} retrying={linksQ.isFetching} />;

  const batches = batchesQ.data;
  if (batches.length === 0) {
    return <EmptyState title="No batches yet" description="Create a batch first (a class group such as 8th CBSE Science), then attach its link and weekly timetable here." />;
  }
  return (
    <div className="cl__stack">
      {batches.map((b) => (
        <BatchCard key={b.id} batch={b} links={linksQ.data.data} teachers={canPickTeacher ? teachers : null} />
      ))}
    </div>
  );
}

function BatchCard({ batch, links, teachers }: { batch: BatchDetail; links: { id: string; name: string; isActive: boolean }[]; teachers: { id: string; fullName: string; initials: string | null }[] | null }) {
  const toast = useToast();
  const qc = useQueryClient();
  const saved = useMemo(() => sortSlots(toSlots(batch)), [batch]);
  const [slots, setSlots] = useState<Slot[]>(saved);
  const dirty = !sameSlots(sortSlots(slots), saved);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: classLinkKeys.batches });
    void qc.invalidateQueries({ queryKey: classLinkKeys.list });
  };

  const assign = useMutation({
    mutationFn: (classLinkId: string | null) => api.academic.updateBatch(batch.id, { classLinkId }),
    onSuccess: (b) => {
      toast.success(b.classLink ? `${b.batchName ?? 'Batch'} now uses "${b.classLink.name}"` : `Link removed from ${b.batchName ?? 'batch'}`);
      refresh();
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  const assignTeacher = useMutation({
    mutationFn: (teacherId: string | null) => api.academic.updateBatch(batch.id, { teacherId }),
    onSuccess: (b) => {
      toast.success(b.teacher ? `${b.batchName ?? 'Batch'} is now taught by ${b.teacher.fullName}` : `Teacher removed from ${b.batchName ?? 'batch'}`);
      refresh();
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  const saveSchedule = useMutation({
    mutationFn: () => api.academic.setSchedule(batch.id, sortSlots(slots) as ScheduleSlotInput[]),
    onSuccess: (rows) => {
      toast.success(`Timetable saved (${rows.length} weekly slot${rows.length === 1 ? '' : 's'})`);
      refresh();
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  const options = [
    { value: '', label: 'No link assigned' },
    ...links
      .filter((l) => l.isActive || l.id === batch.classLinkId)
      .map((l) => ({ value: l.id, label: l.isActive ? l.name : `${l.name} (inactive)` })),
  ];

  const update = (i: number, patch: Partial<Slot>) => setSlots((s) => s.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const hasDuplicate = new Set(slots.map((s) => `${s.dayOfWeek}@${s.startTime}`)).size !== slots.length;
  const invalidTime = slots.some((s) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.startTime) || !(s.durationMinutes >= 5 && s.durationMinutes <= 480));

  const noLink = !batch.classLink;

  return (
    <Card>
      <div className="cl__batch-head">
        <div>
          <h3 className="cl__h3">{batch.batchName ?? 'Unnamed batch'}</h3>
          <p className="cl__muted">
            {batch.course?.courseName ?? 'Course'} · {teachers ? '' : batch.teacher ? `${batch.teacher.fullName} · ` : 'No teacher assigned · '}
            {batch.enrollments.length} student{batch.enrollments.length === 1 ? '' : 's'}
          </p>
          {teachers && (
            <Select
              wrapperClassName="cl__teacher-select"
              label="Teacher"
              value={batch.teacherId ?? ''}
              disabled={assignTeacher.isPending}
              onChange={(e) => assignTeacher.mutate(e.target.value || null)}
              options={[
                { value: '', label: teachers.length ? 'No teacher assigned' : 'No teacher accounts yet' },
                ...teachers.map((t) => ({ value: t.id, label: t.initials ? `${t.fullName} (${t.initials})` : t.fullName })),
              ]}
            />
          )}
        </div>
        <Select
          wrapperClassName="cl__link-select"
          label="Standing class link"
          value={batch.classLinkId ?? ''}
          disabled={assign.isPending}
          onChange={(e) => assign.mutate(e.target.value || null)}
          options={options}
        />
      </div>

      <div className="cl__schedule">
        <div className="cl__schedule-title">
          <CalendarClock size={14} aria-hidden="true" /> Weekly timetable (IST)
        </div>
        {noLink && slots.some((x) => !x.classLinkId) && <p className="cl__warn">Assign a class link above (or choose a link for each slot), otherwise those slots will not create any class sessions.</p>}
        {slots.length === 0 && <p className="cl__muted">No weekly slots yet. Add the days and time this batch meets and its class link goes out to parents automatically each morning.</p>}
        {slots.map((s, i) => (
          <div className="cl__slot" key={i}>
            <Select
              label="Day"
              hideLabel
              aria-label={`Day for slot ${i + 1}`}
              value={String(s.dayOfWeek)}
              onChange={(e) => update(i, { dayOfWeek: Number(e.target.value) })}
              options={ORDER.map((d) => ({ value: String(d), label: DAYS[d] }))}
            />
            <Input label="Start time" hideLabel aria-label={`Start time for slot ${i + 1}`} type="time" value={s.startTime} onChange={(e) => update(i, { startTime: e.target.value })} />
            <Input
              label="Minutes"
              hideLabel
              aria-label={`Duration in minutes for slot ${i + 1}`}
              type="number"
              min={5}
              max={480}
              value={String(s.durationMinutes)}
              onChange={(e) => update(i, { durationMinutes: Number(e.target.value) })}
            />
            <Select
              label="Link for this slot"
              hideLabel
              aria-label={`Link for slot ${i + 1}`}
              value={s.classLinkId ?? ''}
              onChange={(e) => update(i, { classLinkId: e.target.value || null })}
              options={[
                { value: '', label: batch.classLink ? `Batch link (${batch.classLink.name})` : 'Batch link (none)' },
                ...links.filter((l) => l.isActive || l.id === s.classLinkId).map((l) => ({ value: l.id, label: l.isActive ? l.name : `${l.name} (inactive)` })),
              ]}
            />
            <Button variant="ghost" size="sm" iconOnly aria-label={`Remove slot ${i + 1}`} icon={<X size={14} />} onClick={() => setSlots((x) => x.filter((_, j) => j !== i))} />
          </div>
        ))}
        {hasDuplicate && <p className="cl__bad">Two slots have the same day and time.</p>}
        <div className="cl__schedule-actions">
          <Button variant="secondary" size="sm" icon={<Plus size={13} />} onClick={() => setSlots((s) => [...s, { dayOfWeek: 1, startTime: '17:00', durationMinutes: 60, classLinkId: null }])}>
            Add slot
          </Button>
          <Button size="sm" loading={saveSchedule.isPending} disabled={!dirty || hasDuplicate || invalidTime || saveSchedule.isPending} onClick={() => saveSchedule.mutate()}>
            Save timetable
          </Button>
          {dirty && (
            <Button variant="ghost" size="sm" onClick={() => setSlots(saved)}>
              Discard changes
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
