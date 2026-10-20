import { useMemo, useState } from 'react';
import { BookOpen, CalendarDays, ClipboardCheck, Link2 } from 'lucide-react';
import { useAuth } from '../../auth/useAuth';
import { EmptyState, ErrorState, KpiBar, PageHeader, SkeletonList, Tabs, type KpiItem, type TabOption } from '../../ui';
import { AssessmentsTab } from './AssessmentsTab';
import { AttendanceTab } from './AttendanceTab';
import { BatchList } from './BatchList';
import { batchLabel } from './helpers';
import { ClassLinksTab } from './ClassLinksTab';
import { todayIst } from './dates';
import { countRoster, useBatches, useSessionsToday, useTodayRosters } from './hooks';
import './teacher.css';

type TabId = 'attendance' | 'links' | 'assessments';

export default function TeacherPortalView() {
  const { hasPermission } = useAuth();
  const canAttendance = hasPermission('attendance:mark');
  const canSessions = hasPermission('sessions:manage');
  const canAcademics = hasPermission('academics:manage');
  const canRead = hasPermission('students:read');

  const today = todayIst();
  const batchesQ = useBatches();
  const batches = useMemo(() => batchesQ.data ?? [], [batchesQ.data]);
  const rosters = useTodayRosters(batches, today, canAttendance);
  const sessionsToday = useSessionsToday(canSessions);

  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>('attendance');

  const tabs = useMemo(() => {
    const t: TabOption<TabId>[] = [];
    if (canAttendance) t.push({ value: 'attendance', label: 'Attendance', icon: <ClipboardCheck size={14} aria-hidden="true" /> });
    if (canSessions) t.push({ value: 'links', label: 'Class links', icon: <Link2 size={14} aria-hidden="true" /> });
    if (canRead) t.push({ value: 'assessments', label: 'Assessments & marks', icon: <BookOpen size={14} aria-hidden="true" /> });
    return t;
  }, [canAttendance, canSessions, canRead]);

  if (batchesQ.isPending) {
    return (
      <div className="tp__stack">
        <PageHeader title="Teacher Portal" />
        <SkeletonList rows={4} />
      </div>
    );
  }
  if (batchesQ.isError) {
    return (
      <div className="tp__stack">
        <PageHeader title="Teacher Portal" />
        <ErrorState error={batchesQ.error} onRetry={() => void batchesQ.refetch()} retrying={batchesQ.isFetching} />
      </div>
    );
  }
  if (batches.length === 0) {
    return (
      <div className="tp__stack">
        <PageHeader title="Teacher Portal" />
        <EmptyState
          icon={<CalendarDays size={22} aria-hidden="true" />}
          title="No batches assigned yet"
          description="Ask an admin to assign you to a batch. Attendance, class links and marks appear here once you have one."
        />
      </div>
    );
  }

  const batch = batches.find((b) => b.id === selected) ?? batches[0];
  const activeTab: TabId = tabs.some((t) => t.value === tab) ? tab : (tabs[0]?.value ?? 'attendance');

  const studentCount = batches.reduce((n, b) => n + b.enrollments.length, 0);
  const rostersReady = canAttendance && rosters.every((r) => !r.loading && !r.failed);
  const markedToday = rosters.reduce((n, r) => n + countRoster(r.roster).marked, 0);
  const kpis: KpiItem[] = [
    { label: 'Batches', value: batches.length },
    { label: 'Students', value: studentCount },
    { label: 'Sessions today', value: canSessions && sessionsToday.data ? sessionsToday.data.length : '—' },
    {
      label: 'Attendance marked today',
      value: rostersReady ? `${markedToday}/${studentCount}` : '—',
      sub: rostersReady ? 'students marked' : undefined,
    },
  ];

  return (
    <div className="tp__stack">
      <PageHeader title="Teacher Portal" subtitle="Attendance, daily class links and marks for your batches." />
      <KpiBar items={kpis} />
      <div className="tp">
        <BatchList
          batches={batches}
          selectedId={batch.id}
          onSelect={setSelected}
          today={canAttendance ? rosters : undefined}
        />
        <section className="tp__main" aria-label={`${batchLabel(batch)} workspace`}>
          {tabs.length === 0 ? (
            <EmptyState title="Nothing to show" description="Your account has no teaching permissions. Ask an admin." />
          ) : (
            <>
              <Tabs options={tabs} value={activeTab} onChange={setTab} ariaLabel="Teacher portal sections" />
              <div role="tabpanel" aria-label={tabs.find((t) => t.value === activeTab)?.label}>
                {activeTab === 'attendance' && <AttendanceTab key={batch.id} batch={batch} />}
                {activeTab === 'links' && <ClassLinksTab key={batch.id} batch={batch} />}
                {activeTab === 'assessments' && <AssessmentsTab key={batch.id} batch={batch} canCreate={canAcademics} />}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
