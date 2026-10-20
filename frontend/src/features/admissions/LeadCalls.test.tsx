import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../services/http';
import { renderWithProviders } from '../../test/renderWithProviders';
import type { CallLog } from '../../types';
import { formatDuration, outcomeBadge } from './call-helpers';
import { LeadCalls } from './LeadCalls';

const m = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('../../services/api', async (orig) => ({
  ...(await orig<typeof import('../../services/api')>()),
  calls: { list: m.list },
}));

const call = (over: Partial<CallLog> = {}): CallLog => ({
  id: 'c1', callId: 'call-1', parentId: 'p1', leadId: 'l1', phone: '919800000000',
  transcript: [{ role: 'agent', text: 'Hello there', ts: 1 }, { role: 'caller', text: 'I need maths help', ts: 2 }],
  summary: 'Parent wants maths tuition', outcome: 'demo_booked', durationSec: 125, createdAt: '2026-10-01T10:00:00.000Z', ...over,
});
const page = (data: CallLog[]) => ({ data, page: 1, limit: 20, total: data.length, totalPages: 1 });

beforeEach(() => vi.clearAllMocks());

describe('LeadCalls', () => {
  it('shows loading then the call with outcome, duration, summary and an expandable transcript', async () => {
    m.list.mockResolvedValue(page([call()]));
    renderWithProviders(<LeadCalls leadId="l1" />);
    expect(await screen.findByText('Demo booked')).toBeInTheDocument();
    expect(m.list.mock.calls[0][0]).toMatchObject({ leadId: 'l1' });
    expect(screen.getByText('2m 5s')).toBeInTheDocument();
    expect(screen.getByText('Parent wants maths tuition')).toBeInTheDocument();
    expect(screen.queryByText('I need maths help')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Show transcript \(2 turns\)/ }));
    expect(screen.getByText(/I need maths help/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Hide transcript' }));
    expect(screen.queryByText(/I need maths help/)).not.toBeInTheDocument();
  });

  it('shows the empty state', async () => {
    m.list.mockResolvedValue(page([]));
    renderWithProviders(<LeadCalls leadId="l1" />);
    expect(await screen.findByText('No calls with this lead yet.')).toBeInTheDocument();
  });

  it('shows the error state and retries', async () => {
    m.list.mockRejectedValueOnce(new ApiError(500, 'calls boom'));
    m.list.mockResolvedValue(page([call({ summary: null, outcome: null, transcript: [], durationSec: null })]));
    renderWithProviders(<LeadCalls leadId="l1" />);
    expect(await screen.findByText('calls boom')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No summary recorded.')).toBeInTheDocument();
    expect(screen.getByText('No outcome')).toBeInTheDocument();
    expect(screen.getByText('Duration unknown')).toBeInTheDocument();
  });

  it('helpers format durations and unknown outcomes', () => {
    expect(formatDuration(45)).toBe('45s');
    expect(outcomeBadge('weird_thing').label).toBe('weird thing');
  });
});
