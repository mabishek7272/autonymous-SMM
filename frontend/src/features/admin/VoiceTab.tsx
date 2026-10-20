import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, XCircle } from 'lucide-react';
import { api } from '../../services/api';
import { Badge, Button, Card, CardHeader, ErrorState, SkeletonList } from '../../ui';

type Readiness = { label: string; tone: 'success' | 'danger' | 'neutral'; detail?: string };

/** Readiness is only claimed when the service reported it; a missing field is shown as "Not reported". */
function readiness(value: unknown): Readiness {
  if (value === true) return { label: 'Ready', tone: 'success' };
  if (value === false) return { label: 'Not ready', tone: 'danger' };
  if (typeof value === 'string' && value) {
    const ok = /^(ok|ready|up|true|loaded|configured)$/i.test(value);
    return { label: ok ? 'Ready' : 'Not ready', tone: ok ? 'success' : 'danger', detail: value };
  }
  return { label: 'Not reported', tone: 'neutral' };
}

export function VoiceTab() {
  const query = useQuery({ queryKey: ['dev', 'voice-status'], queryFn: ({ signal }) => api.dev.voiceStatus({ signal }) });
  return (
    <Card>
      <CardHeader
        title="Voice call agent"
        subtitle="Live status from the call agent service. Nothing here is simulated."
        actions={
          <Button variant="secondary" size="sm" loading={query.isFetching && !query.isPending} onClick={() => void query.refetch()}>
            Refresh
          </Button>
        }
      />
      {query.isPending ? (
        <SkeletonList rows={2} label="Checking voice agent" />
      ) : query.isError ? (
        <ErrorState error={query.error} title="Could not check the voice agent" onRetry={() => void query.refetch()} retrying={query.isFetching} />
      ) : !query.data.reachable ? (
        <div className="adm-banner adm-banner--warn" role="status">
          <strong>Unreachable.</strong> The call agent did not answer{query.data.error ? `: ${query.data.error}` : '.'} Start it with
          {' '}<code>cd backend &amp;&amp; python3 -m uvicorn call_agent.server:app --port 8085</code> and check CALL_AGENT_URL.
        </div>
      ) : (
        <div className="adm-stack">
          <div className="adm-row">
            <Badge tone="success" icon={<CheckCircle2 size={12} aria-hidden="true" />}>Reachable</Badge>
            <span className="adm-muted">
              status {String(query.data.status)}
              {query.data.version ? ` · v${query.data.version}` : ''}
            </span>
          </div>
          <div className="adm-stats">
            {(['stt', 'llm', 'tts'] as const).map((k) => {
              const r = readiness(query.data[k]);
              return (
                <div className="adm-stat" key={k}>
                  <div className="adm-stat__label">{k.toUpperCase()}</div>
                  <div className="adm-row" style={{ marginTop: 4 }}>
                    <Badge tone={r.tone} icon={r.tone === 'danger' ? <XCircle size={12} aria-hidden="true" /> : r.tone === 'success' ? <CheckCircle2 size={12} aria-hidden="true" /> : undefined}>
                      {r.label}
                    </Badge>
                    {r.detail && <span className="adm-muted">{r.detail}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Card>
  );
}
