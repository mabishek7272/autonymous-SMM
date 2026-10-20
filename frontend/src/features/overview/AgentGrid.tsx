import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Zap } from 'lucide-react';
import { useAuth } from '../../auth/useAuth';
import { agents } from '../../services/api';
import { getErrorMessage } from '../../services/http';
import { ACTIVITY_LIMIT } from '../../shell/useActivitySummary';
import type { AgentStatus, AiActivityLog } from '../../types';
import { Button, Card, EmptyState, ErrorState, Skeleton, cx, useToast } from '../../ui';
import { relativeTime } from './format';
import { ROUTINES } from './routines';

interface Tally {
  success: number;
  failure: number;
}

function tallyByAgent(logs: readonly AiActivityLog[]): Map<string, Tally> {
  const map = new Map<string, Tally>();
  for (const l of logs) {
    const t = map.get(l.agentId) ?? { success: 0, failure: 0 };
    if (l.status === 'success') t.success += 1;
    else if (l.status === 'failure') t.failure += 1;
    map.set(l.agentId, t);
  }
  return map;
}

function AgentCard({ agent, tally, canRun }: { agent: AgentStatus; tally: Tally | undefined; canRun: boolean }) {
  const toast = useToast();
  const qc = useQueryClient();
  const routine = ROUTINES[agent.agentId];
  const run = useMutation({
    mutationFn: () => {
      if (!routine) throw new Error('This agent has no manual routine.');
      return routine.run();
    },
    onSuccess: (res) => {
      if (res.ok) toast.success(res.message);
      else toast.error(res.message);
      void qc.invalidateQueries({ queryKey: ['agents'] });
    },
    onError: (err) => toast.error(`${agent.agentId}: ${getErrorMessage(err)}`),
  });
  const active = agent.actionsToday > 0;
  return (
    <div className={cx('ov-agent', active && 'ov-agent--active')} data-testid={`agent-${agent.agentId}`}>
      <div className="ov-agent__head">
        <div className="ov-agent__icon">
          <Bot size={15} aria-hidden="true" />
        </div>
        <span className="ov-agent__name">{agent.agentId}</span>
        <span className="ov-agent__state">
          <span className="ov-agent__dot" aria-hidden="true" />
          {active ? 'Active today' : 'Idle today'}
        </span>
      </div>
      <dl className="ov-agent__stats">
        <div>
          <dt>Actions today</dt>
          <dd>{agent.actionsToday}</dd>
        </div>
        <div>
          <dt>Succeeded (recent)</dt>
          <dd>{tally ? tally.success : '—'}</dd>
        </div>
        <div>
          <dt>Failed (recent)</dt>
          <dd>{tally ? tally.failure : '—'}</dd>
        </div>
      </dl>
      <div className="ov-agent__foot">
        <span className="ov-agent__last">Last run {relativeTime(agent.lastAction)}</span>
        {routine && canRun && (
          <Button variant="warm" size="sm" icon={<Zap size={11} aria-hidden="true" />} loading={run.isPending} onClick={() => run.mutate()} aria-label={`${routine.label} (${agent.agentId})`}>
            {routine.label}
          </Button>
        )}
      </div>
    </div>
  );
}

export function AgentGrid() {
  const { hasPermission } = useAuth();
  const canRun = hasPermission('agents:run');
  const status = useQuery({ queryKey: ['agents', 'status'], queryFn: ({ signal }) => agents.status({ signal }), refetchInterval: 60_000 });
  // Same key as the header's activity summary, so both share one request.
  const log = useQuery({
    queryKey: ['agents', 'activity-log', 'summary', ACTIVITY_LIMIT],
    queryFn: ({ signal }) => agents.activityLog({ limit: ACTIVITY_LIMIT }, { signal }),
  });
  const tallies = log.data ? tallyByAgent(log.data) : null;

  return (
    <Card>
      <div className="ov-card-head" style={{ marginBottom: 14 }}>
        <h2 className="ov-card-title">AI Agent Status</h2>
        <span className="ov-meta">outcomes from the latest {ACTIVITY_LIMIT} log entries</span>
      </div>
      {status.isLoading ? (
        <Skeleton height={220} />
      ) : status.isError ? (
        <ErrorState error={status.error} onRetry={() => void status.refetch()} retrying={status.isFetching} title="Could not load agent status" />
      ) : !status.data || status.data.length === 0 ? (
        <EmptyState title="No agents reported" />
      ) : (
        <div className="ov-agents">
          {status.data.map((a) => (
            <AgentCard key={a.agentId} agent={a} tally={tallies ? (tallies.get(a.agentId) ?? { success: 0, failure: 0 }) : undefined} canRun={canRun} />
          ))}
        </div>
      )}
    </Card>
  );
}
