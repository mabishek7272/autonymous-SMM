import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import App from './App';
import { renderWithProviders } from './test/renderWithProviders';

vi.mock('./features/reports/ReportsView', () => ({ default: () => <div>Reports view loaded</div> }));

vi.mock('./services/api', () => ({
  agents: { activityLog: vi.fn().mockResolvedValue([]), status: vi.fn().mockResolvedValue([]) },
  messages: { status: vi.fn().mockResolvedValue({ state: 'connected', connected: true, loggedIn: true, instance: 'i' }) },
}));

describe('App routing', () => {
  it('redirects anonymous users to the login screen', async () => {
    renderWithProviders(<App />, { user: null, route: '/admissions' });
    expect(await screen.findByRole('heading', { name: 'Sign in to E-Kalavya' })).toBeInTheDocument();
  });

  it('lets a permitted user open a lazy-loaded section', async () => {
    renderWithProviders(<App />, { user: { role: 'manager' }, route: '/reports' });
    expect(await screen.findByText('Reports view loaded')).toBeInTheDocument();
  });

  it('redirects a forbidden route to the first allowed tab', async () => {
    renderWithProviders(<App />, { user: { role: 'teacher' }, route: '/dev' });
    const nav = await screen.findByRole('navigation', { name: 'Main sections' });
    const active = nav.querySelector('a.is-active');
    expect(active).toHaveTextContent('Student Health');
  });

  it('redirects unknown routes to the first allowed tab', async () => {
    renderWithProviders(<App />, { user: { role: 'admin' }, route: '/nope' });
    const nav = await screen.findByRole('navigation', { name: 'Main sections' });
    expect(nav.querySelector('a.is-active')).toHaveTextContent('Admissions');
  });

  it('shows an honest message when the account has no accessible section', async () => {
    renderWithProviders(<App />, { user: { role: 'teacher' }, permissions: [], route: '/' });
    expect(await screen.findByText('No sections available')).toBeInTheDocument();
  });

  it('surfaces a failed session check with a retry button', async () => {
    const retry = vi.fn();
    renderWithProviders(<App />, { user: null, status: 'error', retry, route: '/admissions' });
    expect(await screen.findByText('Could not verify your session')).toBeInTheDocument();
    screen.getByRole('button', { name: 'Retry' }).click();
    expect(retry).toHaveBeenCalled();
  });
});
