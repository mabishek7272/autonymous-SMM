import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Save } from 'lucide-react';
import { api } from '../../services/api';
import { getErrorMessage } from '../../services/http';
import type { DevConfig, DevConfigUpdate, LlmProvider } from '../../types';
import { Button, Card, CardHeader, ErrorState, Input, Select, SkeletonList, useToast } from '../../ui';

const PROVIDERS: { value: LlmProvider; label: string }[] = [
  { value: 'ollama', label: 'Ollama (local)' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'hub', label: 'HUB API' },
  { value: 'deterministic', label: 'Deterministic (no LLM)' },
];

export function ConfigTab() {
  const query = useQuery({ queryKey: ['dev', 'config'], queryFn: ({ signal }) => api.dev.config({ signal }) });
  if (query.isPending) return <SkeletonList rows={5} label="Loading configuration" />;
  if (query.isError) return <ErrorState error={query.error} title="Could not load configuration" onRetry={() => void query.refetch()} retrying={query.isFetching} />;
  return <ConfigForm config={query.data.config} />;
}

function ConfigForm({ config }: { config: DevConfig }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [provider, setProvider] = useState<LlmProvider>(config.llmProvider);
  const [ollamaBaseUrl, setOllamaBaseUrl] = useState(config.ollamaBaseUrl);
  const [ollamaModel, setOllamaModel] = useState(config.ollamaModel);
  const [openaiModel, setOpenaiModel] = useState(config.openaiModel);
  const [openaiKey, setOpenaiKey] = useState('');
  const [openrouterModel, setOpenrouterModel] = useState(config.openrouterModel);
  const [openrouterKey, setOpenrouterKey] = useState('');
  const [hubBaseUrl, setHubBaseUrl] = useState(config.hubBaseUrl);
  const [hubModel, setHubModel] = useState(config.hubModel);
  const [hubKey, setHubKey] = useState('');
  const [evoUrl, setEvoUrl] = useState(config.evolutionGoUrl);
  const [evoInstance, setEvoInstance] = useState(config.evolutionGoInstance);
  const [evoKey, setEvoKey] = useState('');
  const [founder, setFounder] = useState(config.founderWhatsappNumber);
  const [assistant, setAssistant] = useState(config.assistantName);

  const save = useMutation({
    mutationFn: () => {
      const body: DevConfigUpdate = {
        llmProvider: provider,
        ollamaBaseUrl: ollamaBaseUrl.trim(),
        ollamaModel: ollamaModel.trim(),
        openaiModel: openaiModel.trim(),
        openrouterModel: openrouterModel.trim(),
        hubBaseUrl: hubBaseUrl.trim(),
        hubModel: hubModel.trim(),
        evolutionGoUrl: evoUrl.trim(),
        evolutionGoInstance: evoInstance.trim(),
        founderWhatsappNumber: founder.trim(),
        assistantName: assistant.trim(),
        ...(openaiKey ? { openaiApiKey: openaiKey } : {}),
        ...(openrouterKey ? { openrouterApiKey: openrouterKey } : {}),
        ...(hubKey ? { hubApiKey: hubKey } : {}),
        ...(evoKey ? { evolutionGoApiKey: evoKey } : {}),
      };
      return api.dev.updateConfig(body);
    },
    onSuccess: (res) => {
      toast.success(res.message ?? 'Configuration saved');
      setOpenaiKey('');
      setOpenrouterKey('');
      setHubKey('');
      setEvoKey('');
      void qc.invalidateQueries({ queryKey: ['dev'] });
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  const keyHint = (masked: string) => (masked ? `Current key: ${masked}. Leave blank to keep it.` : 'No key set.');

  return (
    <form className="adm-stack" onSubmit={submit}>
      <Card>
        <CardHeader title="LLM provider" subtitle="Runtime settings held by the running server; they reset when it restarts." />
        <div className="adm-form">
          <Select label="Provider" value={provider} options={PROVIDERS} onChange={(e) => setProvider(e.target.value as LlmProvider)} />
          {provider === 'ollama' && (
            <div className="adm-grid-2">
              <Input label="Ollama base URL" value={ollamaBaseUrl} onChange={(e) => setOllamaBaseUrl(e.target.value)} />
              <Input label="Ollama model" value={ollamaModel} onChange={(e) => setOllamaModel(e.target.value)} />
            </div>
          )}
          {provider === 'openai' && (
            <div className="adm-grid-2">
              <Input label="OpenAI model" value={openaiModel} onChange={(e) => setOpenaiModel(e.target.value)} />
              <Input label="OpenAI API key" type="password" autoComplete="off" value={openaiKey} onChange={(e) => setOpenaiKey(e.target.value)} hint={keyHint(config.openaiApiKeyMasked)} />
            </div>
          )}
          {provider === 'openrouter' && (
            <div className="adm-grid-2">
              <Input label="OpenRouter model" value={openrouterModel} onChange={(e) => setOpenrouterModel(e.target.value)} />
              <Input label="OpenRouter API key" type="password" autoComplete="off" value={openrouterKey} onChange={(e) => setOpenrouterKey(e.target.value)} hint={keyHint(config.openrouterApiKeyMasked)} />
            </div>
          )}
          {provider === 'hub' && (
            <div className="adm-grid-2">
              <Input label="HUB API base URL" value={hubBaseUrl} onChange={(e) => setHubBaseUrl(e.target.value)} />
              <Input label="HUB API model" value={hubModel} onChange={(e) => setHubModel(e.target.value)} />
              <Input label="HUB API key" type="password" autoComplete="off" value={hubKey} onChange={(e) => setHubKey(e.target.value)} hint={keyHint(config.hubApiKeyMasked)} />
            </div>
          )}
          {provider === 'deterministic' && (
            <p className="adm-muted">No LLM is called — every agent replies using the built-in rule engine. Nothing to configure here.</p>
          )}
        </div>
      </Card>
      <Card>
        <CardHeader title="WhatsApp gateway (Evolution Go)" />
        <div className="adm-form">
          <div className="adm-grid-2">
            <Input label="Gateway URL" value={evoUrl} onChange={(e) => setEvoUrl(e.target.value)} />
            <Input label="Instance" value={evoInstance} onChange={(e) => setEvoInstance(e.target.value)} />
            <Input label="API key" type="password" autoComplete="off" value={evoKey} onChange={(e) => setEvoKey(e.target.value)} hint={keyHint(config.evolutionGoApiKeyMasked)} />
            <Input
              label="Founder WhatsApp number"
              inputMode="numeric"
              placeholder="+91 98841 97299"
              hint="Any of these work: +91 98841 97299, 91 98841 97299, 919884197299, or just 9884197299."
              value={founder}
              onChange={(e) => setFounder(e.target.value)}
            />
            <Input label="Assistant name" value={assistant} onChange={(e) => setAssistant(e.target.value)} />
          </div>
        </div>
      </Card>
      <div>
        <Button type="submit" icon={<Save size={14} aria-hidden="true" />} loading={save.isPending}>
          Save configuration
        </Button>
      </div>
    </form>
  );
}
