import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Trash2, XCircle } from 'lucide-react';
import { api } from '../../services/api';
import { getErrorMessage } from '../../services/http';
import { Badge, Button, Card, CardHeader, ErrorState, SkeletonList, useConfirm, useToast } from '../../ui';
import { fetchHealth } from './health';

function formatUptime(s: number): string {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return [d ? `${d}d` : '', h ? `${h}h` : '', `${m}m`].filter(Boolean).join(' ');
}

export function SystemTab() {
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const health = useQuery({ queryKey: ['dev', 'health'], queryFn: ({ signal }) => fetchHealth(signal) });
  const config = useQuery({ queryKey: ['dev', 'config'], queryFn: ({ signal }) => api.dev.config({ signal }) });

  const clear = useMutation({
    mutationFn: () => api.dev.clearRedisCache(),
    onSuccess: (res) => {
      toast.success(`Cleared ${res.clearedKeysCount} cached lead conversation${res.clearedKeysCount === 1 ? '' : 's'}`);
      void qc.invalidateQueries({ queryKey: ['dev', 'health'] });
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  const onClear = async () => {
    const ok = await confirm({
      title: 'Clear lead chat memory?',
      message: 'This deletes the cached WhatsApp conversation memory for all leads in Redis. The assistant will lose context of ongoing chats.',
      confirmLabel: 'Clear cache',
      tone: 'danger',
    });
    if (ok) clear.mutate();
  };

  return (
    <div className="adm-stack">
      <Card>
        <CardHeader
          title="Service health"
          actions={
            <Button variant="secondary" size="sm" loading={health.isFetching && !health.isPending} onClick={() => void health.refetch()}>
              Refresh
            </Button>
          }
        />
        {health.isPending ? (
          <SkeletonList rows={2} label="Loading health" />
        ) : health.isError && config.data ? (
          <div className="adm-stack">
            <div className="adm-banner adm-banner--warn" role="status">
              {getErrorMessage(health.error)} Showing the database and Redis state reported by the developer config instead.
              <div style={{ marginTop: 8 }}>
                <Button variant="secondary" size="sm" loading={health.isFetching} onClick={() => void health.refetch()}>
                  Retry
                </Button>
              </div>
            </div>
            <div className="adm-stats">
              {([['postgres', config.data.systemHealth.database], ['redis', config.data.systemHealth.redis]] as const).map(([name, state]) => (
                <div className="adm-stat" key={name}>
                  <div className="adm-stat__label">{name}</div>
                  <div className="adm-row" style={{ marginTop: 4 }}>
                    <Badge tone={state === 'connected' ? 'success' : 'danger'} icon={state === 'connected' ? <CheckCircle2 size={12} aria-hidden="true" /> : <XCircle size={12} aria-hidden="true" />}>
                      {state === 'connected' ? 'Up' : 'Down'}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : health.isError ? (
          <ErrorState error={health.error} title="Could not check health" onRetry={() => void health.refetch()} retrying={health.isFetching} />
        ) : (
          <div className="adm-stack">
            <div className="adm-stats">
              {Object.entries(health.data.checks).map(([name, state]) => (
                <div className="adm-stat" key={name}>
                  <div className="adm-stat__label">{name}</div>
                  <div className="adm-row" style={{ marginTop: 4 }}>
                    <Badge tone={state === 'up' ? 'success' : 'danger'} icon={state === 'up' ? <CheckCircle2 size={12} aria-hidden="true" /> : <XCircle size={12} aria-hidden="true" />}>
                      {state === 'up' ? 'Up' : 'Down'}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
            <span className="adm-muted">
              {health.data.service} v{health.data.version} · status {health.data.status} · checked {new Date(health.data.timestamp).toLocaleTimeString()}
            </span>
          </div>
        )}
        {config.data && (
          <div className="adm-muted" style={{ marginTop: 12 }}>
            Node {config.data.systemHealth.nodeVersion} · uptime {formatUptime(config.data.systemHealth.uptimeSeconds)}
          </div>
        )}
      </Card>
      <Card>
        <CardHeader title="Redis cache" subtitle="Cached WhatsApp conversation memory for leads." />
        <Button variant="danger" icon={<Trash2 size={13} aria-hidden="true" />} loading={clear.isPending} onClick={() => void onClear()}>
          Clear lead chat cache
        </Button>
      </Card>
    </div>
  );
}
