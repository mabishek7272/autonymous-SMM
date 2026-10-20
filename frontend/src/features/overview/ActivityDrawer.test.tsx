import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../services/http';
import { renderWithProviders } from '../../test/renderWithProviders';
import ActivityDrawer from './ActivityDrawer';

const m = vi.hoisted(() => ({ activityLog: vi.fn(), exportLog: vi.fn() }));
vi.mock('../../services/api', () => ({ agents: { activityLog: m.activityLog, exportActivityLog: m.exportLog } }));

const now = new Date().toISOString();
const logs = [
  { id: '1', agentId: 'AdmissionsAI', targetId: null, actionType: 'sent_whatsapp_message', payload: { message: 'Hi parent' }, status: 'success', timestamp: now },
  { id: '2', agentId: 'ChiefOfStaffAI', targetId: null, actionType: 'founder_briefing_dispatched', payload: null, status: 'failure', timestamp: now },
];

beforeEach(() => {
  m.activityLog.mockReset().mockResolvedValue(logs);
  m.exportLog.mockReset().mockResolvedValue('id,agent\n1,A');
});

describe('ActivityDrawer', () => {
  it('does not fetch while closed', () => {
    renderWithProviders(<ActivityDrawer open={false} onClose={() => undefined} />);
    expect(m.activityLog).not.toHaveBeenCalled();
  });

  it('renders entries with status chips and filters by agent', async () => {
    renderWithProviders(<ActivityDrawer open onClose={() => undefined} />);
    expect(await screen.findByText(/Sent whatsapp message: Hi parent/)).toBeInTheDocument();
    expect(m.activityLog).toHaveBeenCalledWith({ limit: 100 }, expect.anything());
    expect(screen.getByText('Failed', { selector: 'span' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'ChiefOfStaffAI' }));
    const list = screen.getByRole('list', { name: 'Agent activity' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: /Failed \(1\)/ }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
  });

  it('shows the empty state', async () => {
    m.activityLog.mockResolvedValue([]);
    renderWithProviders(<ActivityDrawer open onClose={() => undefined} />);
    expect(await screen.findByText('No activity yet')).toBeInTheDocument();
  });

  it('shows the server error and retries', async () => {
    m.activityLog.mockRejectedValueOnce(new ApiError(500, 'Log store offline'));
    renderWithProviders(<ActivityDrawer open onClose={() => undefined} />);
    expect(await screen.findByText('Log store offline')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/Sent whatsapp message/)).toBeInTheDocument();
  });

  it('exports CSV through an authenticated download and toasts', async () => {
    const create = vi.fn(() => 'blob:x');
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const open = vi.spyOn(window, 'open');
    renderWithProviders(<ActivityDrawer open onClose={() => undefined} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Export CSV' }));
    await waitFor(() => expect(m.exportLog).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    expect(await screen.findByText('Activity log exported.')).toBeInTheDocument();
  });

  it('toasts the server message when export fails', async () => {
    m.exportLog.mockRejectedValue(new ApiError(403, 'Forbidden here'));
    renderWithProviders(<ActivityDrawer open onClose={() => undefined} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Export CSV' }));
    expect(await screen.findByText(/Export failed: Forbidden here/)).toBeInTheDocument();
  });

  it('closes on Esc', async () => {
    const onClose = vi.fn();
    renderWithProviders(<ActivityDrawer open onClose={onClose} />);
    await screen.findByText(/Sent whatsapp message/);
    await userEvent.click(screen.getByRole('button', { name: 'AdmissionsAI' }));
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });
});
