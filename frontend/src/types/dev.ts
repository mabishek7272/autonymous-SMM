export type LlmProvider = 'ollama' | 'openai' | 'openrouter' | 'hub' | 'deterministic';

export interface DevConfig {
  llmProvider: LlmProvider;
  ollamaBaseUrl: string;
  ollamaModel: string;
  openaiModel: string;
  openrouterModel: string;
  hubBaseUrl: string;
  hubModel: string;
  useRealLlm: boolean;
  evolutionGoUrl: string;
  evolutionGoInstance: string;
  founderWhatsappNumber: string;
  assistantName: string;
  openaiApiKeyMasked: string;
  openrouterApiKeyMasked: string;
  hubApiKeyMasked: string;
  evolutionGoApiKeyMasked: string;
  /**
   * The backend currently also echoes the raw keys (openaiApiKey, openrouterApiKey, evolutionGoApiKey)
   * in this object. The UI must only ever display the *Masked fields; the raw fields are intentionally untyped.
   */
}

export interface DevSystemHealth {
  database: 'connected' | 'disconnected' | 'error';
  redis: 'connected' | 'disconnected' | 'error';
  nodeVersion: string;
  uptimeSeconds: number;
}

export interface DevConfigResponse {
  config: DevConfig;
  systemHealth: DevSystemHealth;
}

/** Body of POST /dev/config; every field optional. Empty-string secrets are ignored by the server. */
export interface DevConfigUpdate {
  llmProvider?: LlmProvider;
  ollamaBaseUrl?: string;
  ollamaModel?: string;
  openaiApiKey?: string;
  openaiModel?: string;
  openrouterApiKey?: string;
  openrouterModel?: string;
  hubBaseUrl?: string;
  hubModel?: string;
  hubApiKey?: string;
  useRealLlm?: boolean;
  evolutionGoUrl?: string;
  evolutionGoInstance?: string;
  evolutionGoApiKey?: string;
  founderWhatsappNumber?: string;
  assistantName?: string;
}

export interface StatusMessage {
  status: string;
  message?: string;
}

export interface OllamaModel {
  name: string;
  model: string;
  size: number;
  sizeFormatted: string;
  digest: string;
  details: Record<string, unknown>;
  capabilities: string[];
  supportsChat: boolean;
  isLoaded: boolean;
  vramSizeFormatted?: string;
  agentAssigned: string;
  modified_at?: string;
}

/** GET /dev/ollama/models. When Ollama is unreachable the backend answers online:false (HTTP 200 or 502). */
export interface OllamaModelsResponse {
  online: boolean;
  baseUrl: string;
  error?: string;
  models: OllamaModel[];
  activeModel?: string;
  activeProvider?: string;
  loadedModel?: string | null;
  vramUsedFormatted?: string;
  count?: number;
}

export interface OllamaPrompt {
  model?: string;
  prompt?: string;
  systemPrompt?: string;
}

export interface LlmCallRecord {
  id: string;
  timestamp: string;
  provider: 'ollama' | 'openai' | 'openrouter';
  model: string;
  agentId: string;
  status: 'success' | 'error';
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  promptPreview: string;
  responsePreview: string;
  errorMessage?: string;
}

export interface OllamaTestResult {
  status: 'success';
  model: string;
  reply: string;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  record: LlmCallRecord;
}

/** One SSE `data:` frame from POST /dev/ollama/stream. */
export interface OllamaStreamEvent {
  token?: string;
  done: boolean;
  error?: string;
  totalTokens?: number;
  latencyMs?: number;
  fullReply?: string;
}

export interface WhatsAppSimulateHistoryItem {
  /** 'p' = parent, anything else = assistant (backend contract). */
  from: 'p' | 'a';
  text: string;
}

export interface WhatsAppSimulateResult {
  status: 'success';
  reply: string;
  latencyMs: number;
  model: string;
  /** Set when Ollama failed and the backend answered with its rule-based fallback; surface this to the user. */
  note?: string;
}

export interface LlmMetrics {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  successRate: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  averageLatencyMs: number;
  minLatencyMs: number;
  maxLatencyMs: number;
  tokensPerSecond: number;
  byModel: Record<string, { requests: number; tokens: number; avgLatencyMs: number }>;
  byAgent: Record<string, { requests: number; tokens: number }>;
  recentCalls: LlmCallRecord[];
}

export interface LlmMonitorResponse {
  status: string;
  metrics: LlmMetrics;
}

export interface ClearCacheResult {
  status: string;
  clearedKeysCount: number;
}

/** GET /dev/voice/status: the call agent's own /health JSON plus `reachable`. Absent fields mean "not reported". */
export interface VoiceStatus {
  reachable: boolean;
  status: string;
  error?: string;
  httpStatus?: number;
  stt?: boolean | string | null;
  llm?: boolean | string | null;
  tts?: boolean | string | null;
  version?: string;
  [key: string]: unknown;
}
