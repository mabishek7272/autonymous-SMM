/**
 * LLM Token & API Monitor Service
 * Tracks token consumption (prompt + completion tokens), latency telemetry,
 * and API call health for Ollama, OpenAI and OpenRouter across all E-Kalavya AI agents.
 * In-memory and starts empty: only real calls are ever recorded (no seeded history).
 */

export interface LlmCallRecord {
  id: string;
  timestamp: string;
  provider: 'ollama' | 'openai' | 'openrouter' | 'hub';
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

export class LlmMonitorService {
  private totalRequests = 0;
  private successfulRequests = 0;
  private failedRequests = 0;
  private totalPromptTokens = 0;
  private totalCompletionTokens = 0;
  private totalLatencyMs = 0;
  private minLatencyMs = 0;
  private maxLatencyMs = 0;
  private modelStats: Record<string, { requests: number; tokens: number; totalLatencyMs: number }> = {};
  private agentStats: Record<string, { requests: number; tokens: number }> = {};
  private recentCalls: LlmCallRecord[] = [];
  private readonly maxRecentCalls = 50;

  /**
   * Records an LLM API call event
   */
  recordCall(data: {
    provider: 'ollama' | 'openai' | 'openrouter' | 'hub';
    model: string;
    agentId?: string;
    status: 'success' | 'error';
    latencyMs: number;
    promptTokens?: number;
    completionTokens?: number;
    promptPreview?: string;
    responsePreview?: string;
    errorMessage?: string;
  }): LlmCallRecord {
    const promptTokens = data.promptTokens || 0;
    const completionTokens = data.completionTokens || 0;
    const totalTokens = promptTokens + completionTokens;
    const agentId = data.agentId || 'AdmissionsAI';

    this.totalRequests++;
    if (data.status === 'success') {
      this.successfulRequests++;
    } else {
      this.failedRequests++;
    }

    this.totalPromptTokens += promptTokens;
    this.totalCompletionTokens += completionTokens;
    this.totalLatencyMs += data.latencyMs;

    if (this.minLatencyMs === 0 || data.latencyMs < this.minLatencyMs) {
      this.minLatencyMs = data.latencyMs;
    }
    if (data.latencyMs > this.maxLatencyMs) {
      this.maxLatencyMs = data.latencyMs;
    }

    // Update byModel stats
    if (!this.modelStats[data.model]) {
      this.modelStats[data.model] = { requests: 0, tokens: 0, totalLatencyMs: 0 };
    }
    this.modelStats[data.model].requests++;
    this.modelStats[data.model].tokens += totalTokens;
    this.modelStats[data.model].totalLatencyMs += data.latencyMs;

    // Update byAgent stats
    if (!this.agentStats[agentId]) {
      this.agentStats[agentId] = { requests: 0, tokens: 0 };
    }
    this.agentStats[agentId].requests++;
    this.agentStats[agentId].tokens += totalTokens;

    const record: LlmCallRecord = {
      id: `llm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
      provider: data.provider,
      model: data.model,
      agentId,
      status: data.status,
      latencyMs: data.latencyMs,
      promptTokens,
      completionTokens,
      totalTokens,
      promptPreview: (data.promptPreview || '').slice(0, 80),
      responsePreview: (data.responsePreview || '').slice(0, 100),
      errorMessage: data.errorMessage,
    };

    this.recentCalls.unshift(record);
    if (this.recentCalls.length > this.maxRecentCalls) {
      this.recentCalls.pop();
    }

    return record;
  }

  /**
   * Aggregates and returns current token and API monitor metrics
   */
  getMetrics(): LlmMetrics {
    const totalTokens = this.totalPromptTokens + this.totalCompletionTokens;
    const avgLatency = this.totalRequests > 0 ? Math.round(this.totalLatencyMs / this.totalRequests) : 0;
    const successRate = this.totalRequests > 0 ? Math.round((this.successfulRequests / this.totalRequests) * 100) : 100;
    const tokensPerSec = avgLatency > 0 ? Math.round(((totalTokens / (this.totalLatencyMs / 1000)))) : 0;

    const byModelFormatted: Record<string, { requests: number; tokens: number; avgLatencyMs: number }> = {};
    for (const [model, stats] of Object.entries(this.modelStats)) {
      byModelFormatted[model] = {
        requests: stats.requests,
        tokens: stats.tokens,
        avgLatencyMs: stats.requests > 0 ? Math.round(stats.totalLatencyMs / stats.requests) : 0,
      };
    }

    return {
      totalRequests: this.totalRequests,
      successfulRequests: this.successfulRequests,
      failedRequests: this.failedRequests,
      successRate,
      totalTokens,
      promptTokens: this.totalPromptTokens,
      completionTokens: this.totalCompletionTokens,
      averageLatencyMs: avgLatency,
      minLatencyMs: this.minLatencyMs,
      maxLatencyMs: this.maxLatencyMs,
      tokensPerSecond: tokensPerSec,
      byModel: byModelFormatted,
      byAgent: { ...this.agentStats },
      recentCalls: [...this.recentCalls],
    };
  }

  /**
   * Resets all monitor metrics
   */
  resetMetrics() {
    this.totalRequests = 0;
    this.successfulRequests = 0;
    this.failedRequests = 0;
    this.totalPromptTokens = 0;
    this.totalCompletionTokens = 0;
    this.totalLatencyMs = 0;
    this.minLatencyMs = 0;
    this.maxLatencyMs = 0;
    this.modelStats = {};
    this.agentStats = {};
    this.recentCalls = [];
  }
}

export const llmMonitorService = new LlmMonitorService();
