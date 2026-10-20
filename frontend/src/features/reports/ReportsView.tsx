import { useMemo, useState } from 'react';
import { useAuth } from '../../auth/useAuth';
import { EmptyState, KpiBar, PageHeader, type KpiItem } from '../../ui';
import { istToday, lastCompletedWeekStart, weekOptions } from './dates';
import { useReminderRules, useReportList, useTodaySessions } from './hooks';
import './reports.css';
import { RemindersSection } from './RemindersSection';
import { TodaySessionsSection } from './TodaySessionsSection';
import { WeeklyReportsSection } from './WeeklyReportsSection';

export default function ReportsView() {
  const { hasPermission } = useAuth();
  const canReports = hasPermission('reports:review');
  const canReminders = hasPermission('reminders:manage');
  const canSessions = hasPermission('sessions:manage');

  const today = useMemo(() => istToday(), []);
  const weeks = useMemo(() => weekOptions(today), [today]);
  const [weekStart, setWeekStart] = useState(() => lastCompletedWeekStart(today));
  const [batchId, setBatchId] = useState('');

  const reports = useReportList(weekStart, batchId, canReports);
  const rules = useReminderRules(canReminders);
  const sessions = useTodaySessions(canSessions);

  const kpis: KpiItem[] = [];
  if (canReports) {
    const rows = reports.data;
    const count = (s: string) => (rows ? String(rows.filter((r) => r.status === s).length) : '—');
    kpis.push(
      { label: 'Drafts to review', value: count('draft'), sub: 'selected week' },
      { label: 'Approved, unsent', value: count('approved'), sub: 'selected week' },
      { label: 'Sent to parents', value: count('sent'), sub: 'selected week' },
      { label: 'Failed sends', value: count('failed'), sub: 'selected week' },
    );
  }
  if (canReminders) {
    const data = rules.data;
    kpis.push({ label: 'Active reminders', value: data ? String(data.filter((r) => r.enabled).length) : '—', sub: data ? `of ${data.length} rules` : undefined });
  }
  if (canSessions) {
    const data = sessions.data;
    kpis.push({
      label: 'Classes today',
      value: data ? String(data.length) : '—',
      sub: data ? `${data.filter((s) => s.announcedAt).length} announced` : undefined,
    });
  }

  if (!canReports && !canReminders && !canSessions) {
    return <EmptyState title="No access" description="Your account does not have permission to view reports or reminders." />;
  }

  return (
    <div className="rp-page">
      <PageHeader title="Reports & Reminders" subtitle="Review weekly parent reports, schedule teacher reminders and check today's class links." />
      <KpiBar items={kpis} />
      {canReports && (
        <WeeklyReportsSection weekStart={weekStart} batchId={batchId} weeks={weeks} onWeekChange={setWeekStart} onBatchChange={setBatchId} />
      )}
      {canReminders && <RemindersSection />}
      {canSessions && <TodaySessionsSection />}
    </div>
  );
}
