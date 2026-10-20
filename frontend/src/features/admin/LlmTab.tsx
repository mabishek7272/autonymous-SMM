import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Play, RotateCcw, Square } from 'lucide-react';
import { api } from '../../services/api';
import { getErrorMessage } from '../../services/http';
import type { OllamaStreamEvent } from '../../types';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, Select, SkeletonList, Textarea, useConfirm, useToast } from '../../ui';

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="adm-stat">
      <div className="adm-stat__label">{label}</div>
      <div className="adm-stat__value">{value}</div>
    </div>
  );
}

export function LlmTab() {
  return (
    <div className="adm-stack">
      <ModelsCard />
      <Playground />
      <MonitorCard />
    </div>
  );
}

const PROVIDER_LABEL: Record<string, string> = {
  ollama: 'Ollama',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  hub: 'HUB API',
};

function ModelsCard() {
  const query = useQuery({ queryKey: ['dev', 'ollama-models'], queryFn: ({ signal }) => api.dev.ollamaModels({ signal }) });
  const providerLabel = PROVIDER_LABEL[query.data?.activeProvider ?? ''] ?? 'LLM provider';
  const isOllama = query.data?.activeProvider === 'ollama';
  return (
    <Card>
      <CardHeader
        title={`${providerLabel} models`}
        subtitle={query.data ? query.data.baseUrl : undefined}
        actions={
          <>
            {query.data && <Badge tone={query.data.online ? 'success' : 'danger'}>{query.data.online ? 'Online' : 'Offline'}</Badge>}
            <Button variant="secondary" size="sm" loading={query.isFetching && !query.isPending} onClick={() => void query.refetch()}>
              Refresh
            </Button>
          </>
        }
      />
      {query.isPending ? (
        <SkeletonList rows={2} label="Loading models" />
      ) : query.isError ? (
        <ErrorState error={query.error} title="Could not load models" onRetry={() => void query.refetch()} retrying={query.isFetching} />
      ) : !query.data.online ? (
        <ErrorState
          title={`${providerLabel} is unreachable`}
          message={query.data.error ?? (isOllama ? 'The Ollama daemon is unreachable.' : `Could not reach ${providerLabel}. Check the API key and model id in Configuration.`)}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      ) : query.data.models.length === 0 ? (
        <EmptyState title="No models installed" description="Ollama is running but reports no installed models." />
      ) : (
        <div className="adm-models">
          {query.data.models.map((m) => (
            <div className="adm-stat" key={m.name}>
              <div className="adm-row" style={{ justifyContent: 'space-between' }}>
                <strong className="adm-mono">{m.name}</strong>
                {m.isLoaded ? <Badge tone="success">Loaded</Badge> : <Badge>Idle</Badge>}
              </div>
              <div className="adm-muted">
                {m.sizeFormatted}
                {m.vramSizeFormatted ? ` · VRAM ${m.vramSizeFormatted}` : ''}
              </div>
              <div className="adm-muted">Assigned to {m.agentAssigned}</div>
              {query.data.activeModel === m.name && <Badge tone="primary">Active model</Badge>}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function Playground() {
  const toast = useToast();
  const qc = useQueryClient();
  const models = useQuery({ queryKey: ['dev', 'ollama-models'], queryFn: ({ signal }) => api.dev.ollamaModels({ signal }) });
  const providerLabel = PROVIDER_LABEL[models.data?.activeProvider ?? ''] ?? 'configured';
  const [model, setModel] = useState('');
  const [prompt, setPrompt] = useState('');
  const [system, setSystem] = useState('');
  const [output, setOutput] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<OllamaStreamEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const modelOptions = (models.data?.models ?? []).map((m) => ({ value: m.name, label: m.name }));

  const run = async () => {
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setRunning(true);
    setOutput('');
    setResult(null);
    setError(null);
    try {
      const done = await api.dev.ollamaStream(
        {
          ...(model ? { model } : {}),
          prompt: prompt.trim(),
          ...(system.trim() ? { systemPrompt: system.trim() } : {}),
        },
        { signal: ctrl.signal, onToken: (t) => setOutput((o) => o + t) },
      );
      setResult(done);
      toast.success(`Stream finished${done.latencyMs !== undefined ? ` in ${done.latencyMs} ms` : ''}`);
      void qc.invalidateQueries({ queryKey: ['dev', 'llm-monitor'] });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setError('Stopped.');
      } else {
        const msg = getErrorMessage(err);
        setError(msg);
        toast.error(msg);
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  return (
    <Card>
      <CardHeader title="Streaming test" subtitle={`Sends a prompt to the configured ${providerLabel} server and streams the reply.`} />
      <div className="adm-form">
        <Select label="Model" value={model} placeholder="Server default" options={modelOptions} onChange={(e) => setModel(e.target.value)} />
        <Textarea label="Prompt" rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        <Textarea label="System prompt (optional)" rows={2} value={system} onChange={(e) => setSystem(e.target.value)} hint="Blank uses the server's default system prompt." />
        <div className="adm-row">
          {running ? (
            <Button variant="danger" icon={<Square size={13} aria-hidden="true" />} onClick={() => abortRef.current?.abort()}>
              Stop
            </Button>
          ) : (
            <Button icon={<Play size={13} aria-hidden="true" />} disabled={!prompt.trim()} onClick={() => void run()}>
              Run stream
            </Button>
          )}
          {running && <span className="adm-muted">Streaming...</span>}
        </div>
        {(output || running || result || error) && (
          <div>
            <pre className="adm-pre" aria-live="polite" aria-label="Model output">
              {output}
            </pre>
            {error && (
              <div className="adm-banner adm-banner--bad" role="alert" style={{ marginTop: 8 }}>
                {error}
              </div>
            )}
            {result && (
              <div className="adm-muted" style={{ marginTop: 8 }}>
                {result.totalTokens !== undefined && `${result.totalTokens} tokens`}
                {result.latencyMs !== undefined && ` · ${result.latencyMs} ms`}
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

function MonitorCard() {
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ['dev', 'llm-monitor'], queryFn: ({ signal }) => api.dev.llmMonitor({ signal }) });
  const reset = useMutation({
    mutationFn: () => api.dev.resetLlmMonitor(),
    onSuccess: (res) => {
      toast.success(res.message ?? 'LLM monitor reset');
      void qc.invalidateQueries({ queryKey: ['dev', 'llm-monitor'] });
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });
  const onReset = async () => {
    const ok = await confirm({ title: 'Reset LLM monitor?', message: 'This clears all recorded call metrics.', confirmLabel: 'Reset', tone: 'danger' });
    if (ok) reset.mutate();
  };
  const m = query.data?.metrics;
  return (
    <Card>
      <CardHeader
        title="LLM usage"
        subtitle="Recorded by the server since it started or was last reset."
        actions={
          <Button variant="secondary" size="sm" icon={<RotateCcw size={13} aria-hidden="true" />} loading={reset.isPending} onClick={() => void onReset()}>
            Reset monitor
          </Button>
        }
      />
      {query.isPending ? (
        <SkeletonList rows={2} label="Loading LLM usage" />
      ) : query.isError ? (
        <ErrorState error={query.error} title="Could not load LLM usage" onRetry={() => void query.refetch()} retrying={query.isFetching} />
      ) : !m || m.totalRequests === 0 ? (
        <EmptyState title="No LLM calls recorded" description="Run the streaming test or simulate a WhatsApp message to record calls." />
      ) : (
        <div className="adm-stack">
          <div className="adm-stats">
            <Stat label="Requests" value={m.totalRequests} />
            <Stat label="Success rate" value={`${m.successRate}%`} />
            <Stat label="Total tokens" value={m.totalTokens} />
            <Stat label="Avg latency" value={`${Math.round(m.averageLatencyMs)} ms`} />
            <Stat label="Tokens / sec" value={m.tokensPerSecond} />
            <Stat label="Failed" value={m.failedRequests} />
          </div>
        </div>
      )}
    </Card>
  );
}
