import type { ReactElement, ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderOptions } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext, type AuthContextValue, type AuthStatus } from '../auth/auth-context';
import type { LoginOtpChallenge, Permission, Role, SessionUser } from '../types';
import { ConfirmProvider, ToastProvider } from '../ui';

/** Mirror of backend ROLE_PERMISSIONS, used only to build realistic test sessions. */
const ALL: Permission[] = [
  'users:manage', 'leads:manage', 'students:read', 'students:manage', 'academics:manage',
  'attendance:mark', 'sessions:manage', 'classlinks:manage', 'reports:review', 'reminders:manage', 'dashboard:view',
  'agents:view', 'agents:run', 'approvals:decide', 'approvals:decide_high_risk', 'dev:console',
];

export const ROLE_PERMISSIONS_FIXTURE: Record<Role, Permission[]> = {
  superadmin: ALL,
  admin: ALL.filter((p) => p !== 'dev:console' && p !== 'approvals:decide_high_risk'),
  manager: [
    'leads:manage', 'students:read', 'students:manage', 'academics:manage', 'attendance:mark',
    'sessions:manage', 'classlinks:manage', 'reports:review', 'reminders:manage', 'dashboard:view', 'agents:view',
  ],
  teacher: ['students:read', 'attendance:mark', 'sessions:manage', 'academics:manage'],
};

export function makeSessionUser(overrides: Partial<SessionUser> = {}): SessionUser {
  const role = overrides.role ?? 'admin';
  return {
    id: 'user-1',
    fullName: 'Test User',
    email: 'test.user@example.test',
    role,
    phone: null,
    initials: null,
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    permissions: ROLE_PERMISSIONS_FIXTURE[role],
    ...overrides,
  };
}

export interface ProviderOptions extends Omit<RenderOptions, 'wrapper'> {
  /** Session user; pass null for an anonymous session. Permissions default from the role. */
  user?: Partial<SessionUser> | null;
  /** Shortcut to override the permission list. */
  permissions?: Permission[];
  status?: AuthStatus;
  route?: string;
  login?: AuthContextValue['login'];
  verifyOtp?: AuthContextValue['verifyOtp'];
  resendOtp?: AuthContextValue['resendOtp'];
  logout?: AuthContextValue['logout'];
  retry?: AuthContextValue['retry'];
  queryClient?: QueryClient;
}

export function createTestQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
}

export function buildAuthValue(options: ProviderOptions = {}): AuthContextValue {
  const user = options.user === null ? null : makeSessionUser({ ...options.user, ...(options.permissions ? { permissions: options.permissions } : {}) });
  const permissions = user?.permissions ?? [];
  return {
    status: options.status ?? (user ? 'authenticated' : 'anonymous'),
    user,
    permissions,
    error: null,
    login: options.login ?? (() => Promise.resolve({ otpRequired: true, otpToken: 'test-otp-token', expiresInSeconds: 600, devBypass: false, maskedEmail: 'te***@example.test' } as LoginOtpChallenge)),
    verifyOtp: options.verifyOtp ?? (() => Promise.resolve()),
    resendOtp: options.resendOtp ?? (() => Promise.resolve({ otpRequired: true, otpToken: 'test-otp-token', expiresInSeconds: 600, devBypass: false, maskedEmail: 'te***@example.test' } as LoginOtpChallenge)),
    logout: options.logout ?? (() => undefined),
    retry: options.retry ?? (() => undefined),
    hasPermission: (p) => permissions.includes(p),
    hasAnyPermission: (ps) => ps.some((p) => permissions.includes(p)),
  };
}

/**
 * Renders with react-query (retry off), toasts, confirm dialog, a configurable AuthContext and a MemoryRouter.
 * Tests replace the api layer at the module boundary with vi.mock of '../services/api'.
 */
export function renderWithProviders(ui: ReactElement, options: ProviderOptions = {}) {
  const { route = '/', queryClient = createTestQueryClient(), ...rest } = options;
  const auth = buildAuthValue(options);
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <ConfirmProvider>
          <AuthContext.Provider value={auth}>
            <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>
          </AuthContext.Provider>
        </ConfirmProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
  const { user: _u, permissions: _p, status: _s, login: _l, verifyOtp: _v, resendOtp: _ro, logout: _lo, retry: _r, ...renderOptions } = rest;
  void [_u, _p, _s, _l, _v, _ro, _lo, _r];
  return { queryClient, auth, ...render(ui, { wrapper: Wrapper, ...renderOptions }) };
}
