import { useQuery } from '@tanstack/react-query';
import { ShieldAlert } from 'lucide-react';
import { useAuth } from '../../auth/useAuth';
import { dashboard } from '../../services/api';
import { EmptyState, ErrorState, KpiBar, PageHeader, type KpiItem } from '../../ui';
import { AgentGrid } from './AgentGrid';
import { ApprovalQueue } from './ApprovalQueue';
import { FunnelCard } from './FunnelCard';
import { BriefingCard, ExceptionsCard, TokenUsageCard } from './InsightCards';
import { BatchPerformanceCard, LeadSourcesCard } from './OverviewSections';
import { formatInr, formatNumber } from './format';
import { usePendingApprovals } from './hooks';
import './overview.css';

const WINDOW_DAYS = 30;

export default function OverviewView() {
  const { hasPermission } = useAuth();
  const canDashboard = hasPermission('dashboard:view');
  const canAgents = hasPermission('agents:view');
  const canDev = hasPermission('dev:console');

  const overview = useQuery({ queryKey: ['dashboard', 'overview', WINDOW_DAYS], queryFn: ({ signal }) => dashboard.overview(WINDOW_DAYS, { signal }), enabled: canDashboard });
  const pending = usePendingApprovals(canAgents);
  const o = overview.data;

  const kpis: KpiItem[] = o
    ? [
        o.revenue === null
          ? { label: `Revenue (${o.days}d)`, value: '—', sub: 'No payments recorded yet' }
          : { label: `Revenue (${o.days}d)`, value: formatInr(o.revenue), sub: 'Sum of recorded payments' },
        { label: 'Active students', value: formatNumber(o.activeStudents) },
        { label: `New leads (${o.days}d)`, value: formatNumber(o.leads.total) },
        { label: 'Conversion rate', value: o.conversionRate === null ? '—' : `${o.conversionRate}%`, sub: o.conversionRate === null ? 'No leads in this period' : undefined },
        { label: 'Demos this week', value: formatNumber(o.demosThisWeek) },
      ]
    : [];

  const pendingCount = pending.data?.length ?? 0;

  return (
    <div className="ov">
      <PageHeader
        title="Founder Oversight"
        subtitle={o ? `Last ${o.days} days · all centres · figures in INR` : 'All centres · figures in INR'}
        actions={
          pendingCount > 0 ? (
            <div className="ov-chip" role="status">
              <ShieldAlert size={14} aria-hidden="true" />
              {pendingCount} {pendingCount === 1 ? 'action needs' : 'actions need'} your approval
            </div>
          ) : undefined
        }
      />

      {!canDashboard && !canAgents && !canDev && <EmptyState title="No overview access" description="Your account has no permission to view dashboard or agent data." />}

      {canDashboard && (overview.isError ? <ErrorState error={overview.error} onRetry={() => void overview.refetch()} retrying={overview.isFetching} title="Could not load the overview" /> : <KpiBar items={kpis} loading={overview.isLoading} />)}

      <div className="ov-grid2">
        {canDashboard && <FunnelCard />}
        {canAgents && <AgentGrid />}
      </div>

      {canAgents && <ApprovalQueue enabled={canAgents} />}

      {canDashboard && o && (
        <div className="ov-grid3">
          <LeadSourcesCard overview={o} />
          <BatchPerformanceCard overview={o} />
        </div>
      )}

      {canAgents && (
        <div className="ov-grid2">
          <ExceptionsCard />
          <BriefingCard />
        </div>
      )}

      {canDev && <TokenUsageCard />}
    </div>
  );
}
