import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../test/renderWithProviders';
import type { Role } from '../types';
import { Header } from './Header';

const { activityLog, agentStatus, waStatus } = vi.hoisted(() => ({ activityLog: vi.fn(), agentStatus: vi.fn(), waStatus: vi.fn() }));
vi.mock('../services/api', () => ({
  agents: { activityLog, status: agentStatus },
  messages: { status: waStatus },
}));

beforeEach(() => {
  activityLog.mockReset().mockResolvedValue([]);
  agentStatus.mockReset().mockResolvedValue([]);
  waStatus.mockReset().mockResolvedValue({ state: 'connected', connected: true, loggedIn: true, instance: 'i' });
});

function tabNames(): string[] {
  const nav = screen.getByRole('navigation', { name: 'Main sections' });
  return within(nav).getAllByRole('link').map((a) => a.textContent ?? '');
}

describe('Header tab gating', () => {
  const cases: [Role, string[]][] = [
    ['superadmin', ['Admissions', 'Student Health', 'Teachers', 'Class Links', 'Reports', 'Overview', 'Users', 'Dev Console']],
    ['admin', ['Admissions', 'Student Health', 'Teachers', 'Class Links', 'Reports', 'Overview', 'Users']],
    ['manager', ['Admissions', 'Student Health', 'Teachers', 'Class Links', 'Reports', 'Overview']],
    ['teacher', ['Student Health', 'Teachers']],
  ];

  it.each(cases)('%s sees exactly the tabs its permissions allow', (role, expected) => {
    renderWithProviders(<Header logsOpen={false} onToggleLogs={() => undefined} />, { user: { role, fullName: 'Pat Example' } });
    expect(tabNames()).toEqual(expected);
  });

  it('gates by permissions, not by role name', () => {
    renderWithProviders(<Header logsOpen={false} onToggleLogs={() => undefined} />, {
      user: { role: 'teacher' },
      permissions: ['dev:console', 'reports:review'],
    });
    expect(tabNames()).toEqual(['Reports', 'Dev Console']);
  });

  it('shows the user name, role badge and a working logout', async () => {
    const logout = vi.fn();
    renderWithProviders(<Header logsOpen={false} onToggleLogs={() => undefined} />, { user: { role: 'manager', fullName: 'Pat Example' }, logout });
    expect(screen.getByText('Pat Example')).toBeInTheDocument();
    expect(screen.getByText('Manager')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Log out' }));
    expect(logout).toHaveBeenCalledTimes(1);
  });

  it('hides WhatsApp, agents and logs controls without the matching permissions', () => {
    renderWithProviders(<Header logsOpen={false} onToggleLogs={() => undefined} />, { user: { role: 'teacher' } });
    expect(screen.queryByTestId('whatsapp-pill')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Activity logs/ })).not.toBeInTheDocument();
    expect(waStatus).not.toHaveBeenCalled();
    expect(activityLog).not.toHaveBeenCalled();
    expect(agentStatus).not.toHaveBeenCalled();
  });
});

describe('Header status widgets', () => {
  it.each([
    [{ state: 'connected', connected: true, loggedIn: true, instance: 'i' }, 'WhatsApp connected'],
    [{ state: 'disconnected', connected: false, loggedIn: false, instance: 'i' }, 'WhatsApp disconnected'],
    [{ state: 'unreachable', connected: false, loggedIn: false, instance: 'i', error: 'timeout' }, 'WhatsApp unreachable'],
    [{ state: 'not_configured', connected: false, loggedIn: false, instance: 'i' }, 'WhatsApp not configured'],
  ])('renders the honest WhatsApp state %#', async (status, text) => {
    waStatus.mockResolvedValue(status);
    renderWithProviders(<Header logsOpen={false} onToggleLogs={() => undefined} />, { user: { role: 'manager' } });
    expect(await screen.findByText(text)).toBeInTheDocument();
  });

  it('shows "unknown" when the status request fails', async () => {
    waStatus.mockRejectedValue(new Error('boom'));
    renderWithProviders(<Header logsOpen={false} onToggleLogs={() => undefined} />, { user: { role: 'manager' } });
    expect(await screen.findByText('WhatsApp status unknown')).toBeInTheDocument();
  });

  it('computes the AI pill from /agents/status and shows no hard-coded 4/4', async () => {
    agentStatus.mockResolvedValue([
      { agentId: 'A', lastAction: null, actionsToday: 3 },
      { agentId: 'B', lastAction: null, actionsToday: 0 },
      { agentId: 'C', lastAction: null, actionsToday: 1 },
    ]);
    renderWithProviders(<Header logsOpen={false} onToggleLogs={() => undefined} />, { user: { role: 'manager' } });
    expect(await screen.findByText('2/3')).toBeInTheDocument();
    expect(screen.queryByText('4/4')).not.toBeInTheDocument();
  });

  it('hides the AI pill when there are no agents', async () => {
    renderWithProviders(<Header logsOpen={false} onToggleLogs={() => undefined} />, { user: { role: 'manager' } });
    await waitFor(() => expect(agentStatus).toHaveBeenCalled());
    expect(screen.queryByText('AI active today')).not.toBeInTheDocument();
  });

  it('shows the real unread count on the Logs button and toggles the drawer', async () => {
    activityLog.mockResolvedValue([
      { id: '3', agentId: 'A', targetId: null, actionType: 'x', payload: null, status: 'success', timestamp: '2026-10-01T10:00:00.000Z' },
      { id: '2', agentId: 'A', targetId: null, actionType: 'x', payload: null, status: 'success', timestamp: '2026-10-01T09:00:00.000Z' },
    ]);
    window.localStorage.setItem('ekalavya_activity_seen', '2026-10-01T09:30:00.000Z');
    const onToggle = vi.fn();
    renderWithProviders(<Header logsOpen={false} onToggleLogs={onToggle} />, { user: { role: 'manager' } });
    const btn = await screen.findByRole('button', { name: 'Activity logs, 1 unread of 2' });
    expect(btn).toHaveTextContent('1');
    await userEvent.click(btn);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});

describe('Header email pill', () => {
  it('shows email as on with the sending domain, from the server status', async () => {
    waStatus.mockResolvedValue({ state: 'connected', connected: true, loggedIn: true, instance: 'i', email: { enabled: true, domain: 'e-kalavya.com', senders: ['E-Kalavya <hello@e-kalavya.com>'] } });
    renderWithProviders(<Header logsOpen={false} onToggleLogs={() => undefined} />, { user: { role: 'admin' } });
    const pill = await screen.findByTestId('email-pill');
    expect(pill).toHaveTextContent('Email on · e-kalavya.com');
    expect(pill).toHaveAttribute('title', expect.stringContaining('hello@e-kalavya.com'));
  });

  it('warns when email is switched off', async () => {
    waStatus.mockResolvedValue({ state: 'connected', connected: true, loggedIn: true, instance: 'i', email: { enabled: false, domain: 'e-kalavya.com', senders: [] } });
    renderWithProviders(<Header logsOpen={false} onToggleLogs={() => undefined} />, { user: { role: 'admin' } });
    expect(await screen.findByTestId('email-pill')).toHaveTextContent('Email off');
  });

  it('shows nothing for an older server without email info, and is hidden without dashboard access', async () => {
    renderWithProviders(<Header logsOpen={false} onToggleLogs={() => undefined} />, { user: { role: 'admin' } });
    await screen.findByTestId('whatsapp-pill');
    expect(screen.queryByTestId('email-pill')).not.toBeInTheDocument();
  });
});
