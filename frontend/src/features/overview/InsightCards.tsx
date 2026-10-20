import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Send } from 'lucide-react';
import { useAuth } from '../../auth/useAuth';
import { agents, dev } from '../../services/api';
import { getErrorMessage } from '../../services/http';
import { Badge, BarList, Button, Card, EmptyState, ErrorState, Skeleton, SkeletonList, useToast } from '../../ui';
import { formatNumber, formatPercent, relativeTime } from './format';

const SEVERITY_TONE = { HIGH: 'danger', MEDIUM: 'warning', LOW: 'neutral' } as const;

export function ExceptionsCard() {
  const q = useQuery({ queryKey: ['agents', 'exceptions'], queryFn: ({ signal }) => agents.exceptions({ signal }), refetchInterval: 60_000 });
  const items = q.data ?? [];
  return (
    <Card>
      <div className="ov-card-head" style={{ marginBottom: 10 }}>
        <h2 className="ov-card-title">Exceptions</h2>
        {q.data && <span className="ov-meta">{items.length} open</span>}
      </div>
      {q.isLoading ? (
        <SkeletonList rows={3} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} title="Could not load exceptions" />
      ) : items.length === 0 ? (
        <EmptyState title="No exceptions" description="Nothing needs attention right now." />
      ) : (
        <ul className="ov-list" aria-label="Exceptions">
          {items.map((ex) => (
            <li key={ex.id}>
              <AlertTriangle size={15} aria-hidden="true" color={ex.severity === 'HIGH' ? 'var(--danger)' : 'var(--warning)'} style={{ marginTop: 2, flex: 'none' }} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="ov-list__title">{ex.title}</div>
                <div className="ov-list__sub">{ex.details}</div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                <Badge tone={SEVERITY_TONE[ex.severity] ?? 'neutral'} uppercase>
                  {ex.severity}
                </Badge>
                <span className="ov-hint">{relativeTime(ex.timestamp)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function BriefingCard() {
  const { hasPermission } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['agents', 'founder-briefing'], queryFn: ({ signal }) => agents.founderBriefing({ signal }) });
  const send = useMutation({
    mutationFn: () => agents.runDailyBriefing(),
    onSuccess: (res) => {
      if (res.result.success) toast.success('Daily briefing sent to the founder.');
      else toast.error('The briefing was generated but could not be delivered.');
      void qc.invalidateQueries({ queryKey: ['agents'] });
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });
  const b = q.data;
  return (
    <Card>
      <div className="ov-card-head" style={{ marginBottom: 12 }}>
        <h2 className="ov-card-title">Founder Briefing</h2>
        {hasPermission('agents:run') && (
          <Button variant="primary" size="md" icon={<Send size={13} aria-hidden="true" />} loading={send.isPending} onClick={() => send.mutate()}>
            Send briefing
          </Button>
        )}
      </div>
      {q.isLoading ? (
        <Skeleton height={140} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} title="Could not load the briefing" />
      ) : !b ? (
        <EmptyState title="No briefing available" />
      ) : (
        <>
          <div className="ov-briefing-metrics">
            <Badge tone="primary">{b.metrics.totalLeads} leads</Badge>
            <Badge tone="primary">{b.metrics.demosScheduled} demos</Badge>
            <Badge tone="primary">{b.metrics.activeStudents} students</Badge>
            <Badge tone={b.metrics.exceptionsCount > 0 ? 'warm' : 'neutral'}>{b.metrics.exceptionsCount} exceptions</Badge>
            <Badge tone="neutral">{b.metrics.aiActionsToday} AI actions today</Badge>
          </div>
          <p className="ov-briefing" aria-label={`Briefing for ${b.date}`}>
            {b.briefingText}
          </p>
        </>
      )}
    </Card>
  );
}

/** Real token usage from GET /dev/llm-monitor. Mounted only for dev:console. */
export function TokenUsageCard() {
  const q = useQuery({ queryKey: ['dev', 'llm-monitor'], queryFn: ({ signal }) => dev.llmMonitor({ signal }), refetchInterval: 60_000 });
  const m = q.data?.metrics;
  const byAgent = m ? Object.entries(m.byAgent).sort((a, b) => b[1].tokens - a[1].tokens) : [];
  const byModel = m ? Object.entries(m.byModel).sort((a, b) => b[1].tokens - a[1].tokens) : [];
  return (
    <Card>
      <div className="ov-card-head">
        <h2 className="ov-card-title">AI Token Usage</h2>
        <span className="ov-meta">from the LLM monitor</span>
      </div>
      {q.isLoading ? (
        <Skeleton height={160} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} title="Could not load token usage" />
      ) : !m || m.totalRequests === 0 ? (
        <EmptyState title="No LLM calls recorded" description="Token usage appears once the agents have made model calls." />
      ) : (
        <div className="ov-tokens">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="ov-tile ov-tile--primary">
              <div className="ov-tile__label">Total tokens</div>
              <div className="ov-tile__value">{formatNumber(m.totalTokens)}</div>
              <div className="ov-tile__sub">
                {formatNumber(m.promptTokens)} prompt · {formatNumber(m.completionTokens)} completion
              </div>
            </div>
            <div className="ov-tile">
              <div className="ov-tile__label">Requests</div>
              <div className="ov-tile__value" style={{ fontSize: 22 }}>{formatNumber(m.totalRequests)}</div>
              <div className="ov-tile__sub">
                {formatPercent(m.successRate, 0)} success · {Math.round(m.averageLatencyMs)} ms avg
              </div>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
            <div>
              <div className="ov-hint" style={{ fontWeight: 600, marginBottom: 10 }}>Tokens by agent</div>
              {byAgent.length === 0 ? <span className="ov-hint">No per-agent data</span> : <BarList ariaLabel="Tokens by agent" items={byAgent.map(([name, v]) => ({ label: name, value: v.tokens, display: formatNumber(v.tokens) }))} />}
            </div>
            <div>
              <div className="ov-hint" style={{ fontWeight: 600, marginBottom: 10 }}>Tokens by model</div>
              {byModel.length === 0 ? <span className="ov-hint">No per-model data</span> : <BarList ariaLabel="Tokens by model" items={byModel.map(([name, v]) => ({ label: name, value: v.tokens, display: formatNumber(v.tokens) }))} />}
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
