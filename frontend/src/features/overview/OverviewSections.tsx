import type { DashboardOverview } from '../../types';
import { Badge, Card, EmptyState, Table, healthTone, toneColor, type TableColumn } from '../../ui';
import { formatNumber, formatPercent } from './format';
import { useMounted } from './hooks';

const SOURCE_COLORS = ['#7C3AED', '#F97316', '#059669', '#F59E0B', '#2563EB', '#DC2626', '#8B5CF6', '#94A3B8'];

export function LeadSourcesCard({ overview }: { overview: DashboardOverview }) {
  const mounted = useMounted();
  const sources = overview.leads.bySource;
  const total = sources.reduce((a, s) => a + s.count, 0);
  const r = 60;
  const c = 2 * Math.PI * r;
  const starts = sources.map((_, i) => sources.slice(0, i).reduce((a, s) => a + (s.count / total) * c, 0));
  return (
    <Card>
      <div className="ov-card-head" style={{ marginBottom: 0 }}>
        <h2 className="ov-card-title">Lead Sources</h2>
        <span className="ov-meta">last {overview.days} days</span>
      </div>
      {total === 0 ? (
        <EmptyState title="No leads in this period" />
      ) : (
        <div className="ov-donut" style={{ marginTop: 16 }}>
          <div className="ov-donut__ring">
            <svg width="150" height="150" viewBox="0 0 150 150" role="img" aria-label={`Lead sources: ${sources.map((s) => `${s.source} ${s.count}`).join(', ')}`}>
              <circle cx="75" cy="75" r={r} fill="none" stroke="#F1F5F9" strokeWidth="18" />
              {sources.map((s, i) => {
                const len = (s.count / total) * c;
                return (
                  <circle
                    key={s.source}
                    className="ov-donut__seg"
                    cx="75"
                    cy="75"
                    r={r}
                    fill="none"
                    transform="rotate(-90 75 75)"
                    stroke={SOURCE_COLORS[i % SOURCE_COLORS.length]}
                    strokeWidth="18"
                    strokeDasharray={mounted ? `${len} ${c - len}` : `0 ${c}`}
                    strokeDashoffset={-starts[i]}
                  />
                );
              })}
            </svg>
            <div className="ov-donut__center" aria-hidden="true">
              <span className="ov-donut__total">{formatNumber(total)}</span>
              <span className="ov-donut__cap">Leads</span>
            </div>
          </div>
          <ul className="ov-legend">
            {sources.map((s, i) => (
              <li key={s.source}>
                <span className="ov-legend__dot" style={{ background: SOURCE_COLORS[i % SOURCE_COLORS.length] }} aria-hidden="true" />
                <span className="ov-legend__name">{s.source}</span>
                <span className="ov-legend__val">
                  {s.count} · {Math.round((s.count / total) * 100)}%
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

type BatchRow = DashboardOverview['batches'][number];

const HEALTH_LABEL: Record<string, string> = { GREEN: 'Healthy', YELLOW: 'Watch', RED: 'At risk', UNKNOWN: 'No data' };

const columns: TableColumn<BatchRow>[] = [
  { key: 'batch', header: 'Batch', render: (b) => <strong>{b.batch ?? b.course}</strong>, sortValue: (b) => b.batch ?? b.course },
  { key: 'course', header: 'Course', render: (b) => b.course, sortValue: (b) => b.course },
  { key: 'teacher', header: 'Teacher', render: (b) => b.teacher?.name ?? '—', sortValue: (b) => b.teacher?.name ?? null },
  { key: 'students', header: 'Students', align: 'right', render: (b) => <span className="ov-mono">{b.students}</span>, sortValue: (b) => b.students },
  { key: 'avg', header: 'Avg score', align: 'right', render: (b) => <span className="ov-mono">{formatPercent(b.avgScore)}</span>, sortValue: (b) => b.avgScore },
  { key: 'att', header: 'Attendance', align: 'right', render: (b) => <span className="ov-mono">{formatPercent(b.attendance)}</span>, sortValue: (b) => b.attendance },
  {
    key: 'health',
    header: 'Health',
    render: (b) => (
      <Badge tone={b.health === 'GREEN' ? 'success' : b.health === 'YELLOW' ? 'warning' : b.health === 'RED' ? 'danger' : 'neutral'} uppercase>
        <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: '50%', background: toneColor(healthTone(b.health)) }} />
        {HEALTH_LABEL[b.health] ?? b.health}
      </Badge>
    ),
    sortValue: (b) => HEALTH_LABEL[b.health] ?? b.health,
  },
];

export function BatchPerformanceCard({ overview }: { overview: DashboardOverview }) {
  return (
    <Card>
      <div className="ov-card-head" style={{ marginBottom: 10 }}>
        <h2 className="ov-card-title">Batch Performance</h2>
        <span className="ov-hint">Click a column to sort</span>
      </div>
      <Table
        caption="Batch performance"
        columns={columns}
        rows={overview.batches}
        rowKey={(b) => b.batchId}
        empty={<EmptyState title="No batches yet" description="Batches appear here once they are created and have students." />}
      />
    </Card>
  );
}
