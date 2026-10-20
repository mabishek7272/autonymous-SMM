import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../services/http';
import { renderWithProviders } from '../../test/renderWithProviders';
import DevConsoleView from './DevConsoleView';

const m = vi.hoisted(() => ({ voiceStatus: vi.fn(), config: vi.fn() }));
vi.mock('../../services/api', () => ({
  api: { dev: { voiceStatus: m.voiceStatus, config: m.config }, messages: { status: vi.fn() } },
}));

const su = { user: { role: 'superadmin' as const } };
const openVoice = async () => {
  renderWithProviders(<DevConsoleView />, su);
  await userEvent.click(screen.getByRole('tab', { name: 'Voice' }));
};

beforeEach(() => {
  vi.clearAllMocks();
  m.config.mockResolvedValue({ config: {}, systemHealth: {} });
});

describe('Voice tab', () => {
  it('shows an honest unreachable state', async () => {
    m.voiceStatus.mockResolvedValue({ reachable: false, status: 'unreachable', error: 'fetch failed' });
    await openVoice();
    expect(await screen.findByText(/Unreachable/)).toBeInTheDocument();
    expect(screen.getByText(/fetch failed/)).toBeInTheDocument();
    expect(screen.queryByText('Ready')).not.toBeInTheDocument();
  });

  it('shows reported stt/llm/tts readiness and marks unreported fields as such', async () => {
    m.voiceStatus.mockResolvedValue({ reachable: true, status: 'ok', stt: true, llm: false, version: '1.2.3' });
    await openVoice();
    expect(await screen.findByText('Reachable')).toBeInTheDocument();
    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.getByText('Not ready')).toBeInTheDocument();
    expect(screen.getByText('Not reported')).toBeInTheDocument();
    expect(screen.getByText(/v1\.2\.3/)).toBeInTheDocument();
  });

  it('shows request errors with retry', async () => {
    m.voiceStatus.mockRejectedValueOnce(new ApiError(500, 'status boom'));
    m.voiceStatus.mockResolvedValue({ reachable: true, status: 'ok', stt: true, llm: true, tts: true });
    await openVoice();
    expect(await screen.findByText('status boom')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Reachable')).toBeInTheDocument();
    expect(screen.getAllByText('Ready')).toHaveLength(3);
  });
});
