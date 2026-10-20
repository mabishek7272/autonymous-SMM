import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '../test/renderWithProviders';
import { RequirePermission } from './RequirePermission';

describe('RequirePermission', () => {
  it('renders children when the permission is held', () => {
    renderWithProviders(
      <RequirePermission permission="leads:manage">
        <span>secret</span>
      </RequirePermission>,
      { permissions: ['leads:manage'] },
    );
    expect(screen.getByText('secret')).toBeInTheDocument();
  });

  it('renders the fallback when the permission is missing, regardless of role name', () => {
    renderWithProviders(
      <RequirePermission permission="dev:console" fallback={<span>denied</span>}>
        <span>secret</span>
      </RequirePermission>,
      { user: { role: 'superadmin' }, permissions: ['leads:manage'] },
    );
    expect(screen.queryByText('secret')).not.toBeInTheDocument();
    expect(screen.getByText('denied')).toBeInTheDocument();
  });

  it('renders nothing by default when denied', () => {
    renderWithProviders(
      <RequirePermission permission="users:manage">
        <span>secret</span>
      </RequirePermission>,
      { permissions: [] },
    );
    expect(screen.queryByText('secret')).not.toBeInTheDocument();
  });

  it('supports any/all modes for several permissions', () => {
    const { rerender } = renderWithProviders(
      <RequirePermission permission={['users:manage', 'leads:manage']} fallback={<span>denied</span>}>
        <span>ok-any</span>
      </RequirePermission>,
      { permissions: ['leads:manage'] },
    );
    expect(screen.getByText('ok-any')).toBeInTheDocument();
    rerender(
      <RequirePermission permission={['users:manage', 'leads:manage']} mode="all" fallback={<span>denied</span>}>
        <span>ok-all</span>
      </RequirePermission>,
    );
    expect(screen.queryByText('ok-all')).not.toBeInTheDocument();
    expect(screen.getByText('denied')).toBeInTheDocument();
  });
});
