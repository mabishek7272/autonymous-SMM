import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../services/http';
import { renderWithProviders } from '../../test/renderWithProviders';
import DevConsoleView from './DevConsoleView';

const m = vi.hoisted(() => ({
  config: vi.fn(), updateConfig: vi.fn(), testWhatsApp: vi.fn(), clearRedisCache: vi.fn(), ollamaModels: vi.fn(),
  ollamaStream: vi.fn(), simulateWhatsApp: vi.fn(), llmMonitor: vi.fn(), resetLlmMonitor: vi.fn(), status: vi.fn(), health: vi.fn(),
}));
vi.mock('../../services/api', () => ({
  api: {
    dev: {
      config: m.config, updateConfig: m.updateConfig, testWhatsApp: m.testWhatsApp, clearRedisCache: m.clearRedisCache,
      ollamaModels: m.ollamaModels, ollamaStream: m.ollamaStream, simulateWhatsApp: m.simulateWhatsApp,
      llmMonitor: m.llmMonitor, resetLlmMonitor: m.resetLlmMonitor,
    },
    messages: { status: m.status },
  },
}));
vi.mock('./health', () => ({ fetchHealth: m.health }));

const cfg = {
  config: {
    llmProvider: 'ollama', ollamaBaseUrl: 'http://ollama.test', ollamaModel: 'm1', openaiModel: 'g', openrouterModel: 'r', useRealLlm: true,
    evolutionGoUrl: 'http://evo.test', evolutionGoInstance: 'inst', founderWhatsappNumber: '911234567890', assistantName: 'Asst',
    openaiApiKeyMasked: 'sk-a••••wxyz', openrouterApiKeyMasked: '', evolutionGoApiKeyMasked: '',
  },
  systemHealth: { database: 'connected', redis: 'connected', nodeVersion: 'v22.0.0', uptimeSeconds: 3700 },
};
const su = { user: { role: 'superadmin' as const } };
const tab = (name: string) => userEvent.click(screen.getByRole('tab', { name }));

beforeEach(() => {
  vi.clearAllMocks();
  m.config.mockResolvedValue(cfg);
});

describe('DevConsoleView', () => {
  it('is gated by dev:console', () => {
    renderWithProviders(<DevConsoleView />, { user: { role: 'admin' } });
    expect(screen.getByText('No access')).toBeInTheDocument();
    expect(m.config).not.toHaveBeenCalled();
  });

  it('config: error and retry', async () => {
    m.config.mockRejectedValueOnce(new ApiError(500, 'config boom'));
    renderWithProviders(<DevConsoleView />, su);
    expect(await screen.findByText('config boom')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByLabelText('Ollama model')).toHaveValue('m1');
  });

  it('config: shows masked keys and saves, sending keys only when typed', async () => {
    m.updateConfig.mockResolvedValue({ status: 'success', message: 'Runtime configuration updated successfully' });
    renderWithProviders(<DevConsoleView />, su);
    expect(await screen.findByText(/sk-a••••wxyz/)).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Provider'), 'openai');
    await userEvent.click(screen.getByRole('button', { name: 'Save configuration' }));
    await waitFor(() => expect(m.updateConfig).toHaveBeenCalled());
    const body = m.updateConfig.mock.calls[0][0];
    expect(body.llmProvider).toBe('openai');
    expect(body).not.toHaveProperty('openaiApiKey');
    expect(await screen.findByText('Runtime configuration updated successfully')).toBeInTheDocument();
  });

  it('config: shows save errors', async () => {
    m.updateConfig.mockRejectedValue(new ApiError(500, 'save failed'));
    renderWithProviders(<DevConsoleView />, su);
    await screen.findByLabelText('Ollama model');
    await userEvent.click(screen.getByRole('button', { name: 'Save configuration' }));
    expect(await screen.findByText('save failed')).toBeInTheDocument();
  });

  describe('llm tab', () => {
    beforeEach(() => {
      m.ollamaModels.mockResolvedValue({
        online: true, baseUrl: 'http://ollama.test', activeModel: 'qwen:1', models: [
          { name: 'qwen:1', model: 'qwen:1', size: 1, sizeFormatted: '4 GB', digest: '', details: {}, capabilities: [], supportsChat: true, isLoaded: true, agentAssigned: 'AdmissionsAI' },
        ],
      });
      m.llmMonitor.mockResolvedValue({ status: 'success', metrics: { totalRequests: 3, successfulRequests: 3, failedRequests: 0, successRate: 100, totalTokens: 120, promptTokens: 40, completionTokens: 80, averageLatencyMs: 250, minLatencyMs: 1, maxLatencyMs: 2, tokensPerSecond: 12, byModel: {}, byAgent: {}, recentCalls: [] } });
    });

    it('renders models and metrics', async () => {
      renderWithProviders(<DevConsoleView />, su);
      await tab('LLM');
      expect(await screen.findByText('Online')).toBeInTheDocument();
      expect(screen.getAllByText('qwen:1').length).toBeGreaterThan(0);
      expect(await screen.findByText('250 ms')).toBeInTheDocument();
    });

    it('shows offline state with server message', async () => {
      m.ollamaModels.mockResolvedValue({ online: false, baseUrl: 'x', models: [], error: 'Ollama daemon unreachable' });
      m.llmMonitor.mockResolvedValue({ status: 'success', metrics: { totalRequests: 0 } });
      renderWithProviders(<DevConsoleView />, su);
      await tab('LLM');
      expect(await screen.findByText('Ollama daemon unreachable')).toBeInTheDocument();
      expect(await screen.findByText('No LLM calls recorded')).toBeInTheDocument();
    });

    it('streams tokens', async () => {
      m.ollamaStream.mockImplementation(async (_b: unknown, h: { onToken: (t: string) => void }) => {
        h.onToken('Hel');
        h.onToken('lo');
        return { done: true, totalTokens: 2, latencyMs: 90 };
      });
      renderWithProviders(<DevConsoleView />, su);
      await tab('LLM');
      await userEvent.type(await screen.findByLabelText('Prompt'), 'hi');
      await userEvent.click(screen.getByRole('button', { name: 'Run stream' }));
      expect(await screen.findByLabelText('Model output')).toHaveTextContent('Hello');
      expect(await screen.findByText(/2 tokens/)).toBeInTheDocument();
      expect(m.ollamaStream.mock.calls[0][0]).toEqual({ prompt: 'hi' });
    });

    it('surfaces stream errors', async () => {
      m.ollamaStream.mockRejectedValue(new ApiError(500, 'Ollama HTTP 404'));
      renderWithProviders(<DevConsoleView />, su);
      await tab('LLM');
      await userEvent.type(await screen.findByLabelText('Prompt'), 'hi');
      await userEvent.click(screen.getByRole('button', { name: 'Run stream' }));
      expect((await screen.findAllByText('Ollama HTTP 404')).length).toBeGreaterThan(0);
    });

    it('resets the monitor after confirmation', async () => {
      m.resetLlmMonitor.mockResolvedValue({ status: 'success', message: 'Monitor cleared' });
      renderWithProviders(<DevConsoleView />, su);
      await tab('LLM');
      await userEvent.click(await screen.findByRole('button', { name: 'Reset monitor' }));
      await userEvent.click(await screen.findByRole('button', { name: 'Reset' }));
      await waitFor(() => expect(m.resetLlmMonitor).toHaveBeenCalled());
      expect(await screen.findByText('Monitor cleared')).toBeInTheDocument();
    });
  });

  describe('whatsapp tab', () => {
    beforeEach(() => m.status.mockResolvedValue({ state: 'connected', connected: true, loggedIn: true, instance: 'inst' }));

    it('shows gateway status', async () => {
      renderWithProviders(<DevConsoleView />, su);
      await tab('WhatsApp');
      expect(await screen.findByText('Connected')).toBeInTheDocument();
    });

    it('shows status error with retry', async () => {
      m.status.mockRejectedValueOnce(new ApiError(500, 'status down'));
      renderWithProviders(<DevConsoleView />, su);
      await tab('WhatsApp');
      expect(await screen.findByText('status down')).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
      expect(await screen.findByText('Connected')).toBeInTheDocument();
    });

    it('sends a test message', async () => {
      m.testWhatsApp.mockResolvedValue({ status: 'success', result: {} });
      renderWithProviders(<DevConsoleView />, su);
      await tab('WhatsApp');
      await userEvent.type(await screen.findByLabelText(/^To/), '919800000000');
      await userEvent.click(screen.getByRole('button', { name: 'Send test message' }));
      await waitFor(() => expect(m.testWhatsApp).toHaveBeenCalledWith('919800000000', undefined));
      expect(await screen.findByText('Test message sent to 919800000000')).toBeInTheDocument();
    });

    it('simulates an inbound message and shows the real reply and note', async () => {
      m.simulateWhatsApp.mockResolvedValue({ status: 'success', reply: 'Namaskaram!', latencyMs: 12, model: 'm1', note: 'Used fallback reply' });
      renderWithProviders(<DevConsoleView />, su);
      await tab('WhatsApp');
      await userEvent.type(await screen.findByLabelText('Parent message'), 'Fees?');
      await userEvent.click(screen.getByRole('button', { name: 'Simulate message' }));
      const log = await screen.findByRole('log', { name: 'Simulated conversation' });
      expect(within(log).getByText('Namaskaram!')).toBeInTheDocument();
      expect(m.simulateWhatsApp).toHaveBeenCalledWith('Fees?', []);
      expect((await screen.findAllByText('Used fallback reply')).length).toBeGreaterThan(0);
    });
  });

  describe('system tab', () => {
    it('shows postgres and redis state', async () => {
      m.health.mockResolvedValue({ status: 'degraded', service: 'api', checks: { postgres: 'up', redis: 'down' }, timestamp: '2026-01-01T00:00:00Z', version: '1.0.0' });
      renderWithProviders(<DevConsoleView />, su);
      await tab('System');
      expect(await screen.findByText('Up')).toBeInTheDocument();
      expect(screen.getByText('Down')).toBeInTheDocument();
    });

    it('health error and retry', async () => {
      m.health.mockRejectedValueOnce(new ApiError(0, 'no health'));
      m.health.mockResolvedValue({ status: 'ok', service: 'api', checks: { postgres: 'up', redis: 'up' }, timestamp: '2026-01-01T00:00:00Z', version: '1' });
      renderWithProviders(<DevConsoleView />, su);
      await tab('System');
      expect(await screen.findByText(/no health/)).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
      expect((await screen.findAllByText('Up')).length).toBe(2);
    });

    it('clears redis only after confirmation', async () => {
      m.health.mockResolvedValue({ status: 'ok', service: 'api', checks: { postgres: 'up', redis: 'up' }, timestamp: '2026-01-01T00:00:00Z', version: '1' });
      m.clearRedisCache.mockResolvedValue({ status: 'success', clearedKeysCount: 4 });
      renderWithProviders(<DevConsoleView />, su);
      await tab('System');
      await userEvent.click(await screen.findByRole('button', { name: 'Clear lead chat cache' }));
      expect(m.clearRedisCache).not.toHaveBeenCalled();
      await userEvent.click(await screen.findByRole('button', { name: 'Clear cache' }));
      await waitFor(() => expect(m.clearRedisCache).toHaveBeenCalled());
      expect(await screen.findByText('Cleared 4 cached lead conversations')).toBeInTheDocument();
    });
  });
});
