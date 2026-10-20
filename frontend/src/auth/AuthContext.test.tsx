import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../services/http';
import { createTestQueryClient, makeSessionUser } from '../test/renderWithProviders';
import type { LoginOtpChallenge } from '../types';
import { ToastProvider } from '../ui';
import { AuthProvider } from './AuthContext';
import { SESSION_EXPIRED_EVENT, TOKEN_KEY, getToken, setToken } from './session';
import { useAuth } from './useAuth';

const { me, login, verifyOtp, resendOtp } = vi.hoisted(() => ({ me: vi.fn(), login: vi.fn(), verifyOtp: vi.fn(), resendOtp: vi.fn() }));
vi.mock('../services/api', () => ({ auth: { me, login, verifyOtp, resendOtp } }));

const CHALLENGE: LoginOtpChallenge = { otpRequired: true, otpToken: 'otp-tok-1', expiresInSeconds: 600, devBypass: false, maskedEmail: 'a***@b.co' };

function Probe() {
  const a = useAuth();
  const [challenge, setChallenge] = useState<LoginOtpChallenge | null>(null);
  return (
    <div>
      <span data-testid="status">{a.status}</span>
      <span data-testid="name">{a.user?.fullName ?? 'none'}</span>
      <span data-testid="can-leads">{String(a.hasPermission('leads:manage'))}</span>
      <span data-testid="can-dev">{String(a.hasPermission('dev:console'))}</span>
      <span data-testid="error">{a.error ?? ''}</span>
      <span data-testid="challenge">{challenge ? challenge.otpToken : 'none'}</span>
      <button
        onClick={() =>
          void a
            .login('a@b.co', 'secret')
            .then(setChallenge)
            .catch(() => undefined)
        }
      >
        login
      </button>
      <button onClick={() => void (challenge && a.verifyOtp(challenge, '123456').catch(() => undefined))}>verify</button>
      <button
        onClick={() =>
          void (
            challenge &&
            a
              .resendOtp(challenge)
              .then(setChallenge)
              .catch(() => undefined)
          )
        }
      >
        resend
      </button>
      <button onClick={a.logout}>logout</button>
      <button onClick={a.retry}>retry</button>
    </div>
  );
}

function setup() {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <ToastProvider>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  me.mockReset();
  login.mockReset();
  verifyOtp.mockReset();
  resendOtp.mockReset();
});

describe('AuthProvider', () => {
  it('is anonymous without a token and does not call /auth/me', () => {
    setup();
    expect(screen.getByTestId('status')).toHaveTextContent('anonymous');
    expect(me).not.toHaveBeenCalled();
  });

  it('loads the user and permissions from /auth/me when a token is stored', async () => {
    setToken('stored');
    me.mockResolvedValue(makeSessionUser({ fullName: 'Asha Rao', role: 'manager' }));
    setup();
    expect(screen.getByTestId('status')).toHaveTextContent('loading');
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
    expect(screen.getByTestId('name')).toHaveTextContent('Asha Rao');
    expect(screen.getByTestId('can-leads')).toHaveTextContent('true');
    expect(screen.getByTestId('can-dev')).toHaveTextContent('false');
  });

  it('drops an invalid stored token (401)', async () => {
    setToken('bad');
    me.mockRejectedValue(new ApiError(401, 'Invalid or expired token'));
    setup();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('anonymous'));
    expect(getToken()).toBeNull();
  });

  it('reports a non-auth failure as an error state and retries', async () => {
    setToken('stored');
    me.mockRejectedValueOnce(new ApiError(500, 'Failed to fetch user'));
    setup();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('error'));
    expect(screen.getByTestId('error')).toHaveTextContent('Failed to fetch user');
    expect(getToken()).toBe('stored');
    me.mockResolvedValue(makeSessionUser());
    await userEvent.click(screen.getByText('retry'));
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
  });

  it('login (step 1) never stores a token or completes the session — it only returns the OTP challenge', async () => {
    login.mockResolvedValue(CHALLENGE);
    setup();
    await userEvent.click(screen.getByText('login'));
    expect(login).toHaveBeenCalledWith('a@b.co', 'secret');
    await waitFor(() => expect(screen.getByTestId('challenge')).toHaveTextContent('otp-tok-1'));
    expect(screen.getByTestId('status')).toHaveTextContent('anonymous');
    expect(getToken()).toBeNull();
    expect(me).not.toHaveBeenCalled();
  });

  it('login (step 1) failure leaves the user anonymous and stores nothing', async () => {
    login.mockRejectedValue(new ApiError(401, 'Invalid credentials'));
    setup();
    await userEvent.click(screen.getByText('login'));
    await waitFor(() => expect(login).toHaveBeenCalled());
    expect(screen.getByTestId('status')).toHaveTextContent('anonymous');
    expect(getToken()).toBeNull();
  });

  it('verifyOtp (step 2) redeems the code, stores the token under ekalavya_token, and completes the session', async () => {
    login.mockResolvedValue(CHALLENGE);
    verifyOtp.mockResolvedValue({ token: 'jwt-1', user: { id: 'u', fullName: 'X', email: 'a@b.co', role: 'admin', permissions: [] } });
    me.mockResolvedValue(makeSessionUser({ fullName: 'Logged In' }));
    setup();
    await userEvent.click(screen.getByText('login'));
    await waitFor(() => expect(screen.getByTestId('challenge')).toHaveTextContent('otp-tok-1'));
    await userEvent.click(screen.getByText('verify'));
    expect(verifyOtp).toHaveBeenCalledWith('otp-tok-1', '123456');
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
    expect(window.localStorage.getItem(TOKEN_KEY)).toBe('jwt-1');
    expect(screen.getByTestId('name')).toHaveTextContent('Logged In');
  });

  it('verifyOtp failure (wrong code) leaves the user anonymous and stores nothing', async () => {
    login.mockResolvedValue(CHALLENGE);
    verifyOtp.mockRejectedValue(new ApiError(400, 'That code is incorrect.'));
    setup();
    await userEvent.click(screen.getByText('login'));
    await waitFor(() => expect(screen.getByTestId('challenge')).toHaveTextContent('otp-tok-1'));
    await userEvent.click(screen.getByText('verify'));
    await waitFor(() => expect(verifyOtp).toHaveBeenCalled());
    expect(screen.getByTestId('status')).toHaveTextContent('anonymous');
    expect(getToken()).toBeNull();
  });

  it('resendOtp returns a fresh challenge without touching the session', async () => {
    login.mockResolvedValue(CHALLENGE);
    const fresh: LoginOtpChallenge = { ...CHALLENGE, otpToken: 'otp-tok-2' };
    resendOtp.mockResolvedValue(fresh);
    setup();
    await userEvent.click(screen.getByText('login'));
    await waitFor(() => expect(screen.getByTestId('challenge')).toHaveTextContent('otp-tok-1'));
    await userEvent.click(screen.getByText('resend'));
    expect(resendOtp).toHaveBeenCalledWith('otp-tok-1');
    await waitFor(() => expect(screen.getByTestId('challenge')).toHaveTextContent('otp-tok-2'));
    expect(screen.getByTestId('status')).toHaveTextContent('anonymous');
  });

  it('logout clears the token and user', async () => {
    setToken('stored');
    me.mockResolvedValue(makeSessionUser());
    setup();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
    await userEvent.click(screen.getByText('logout'));
    expect(screen.getByTestId('status')).toHaveTextContent('anonymous');
    expect(getToken()).toBeNull();
  });

  it('reacts to the session-expired event', async () => {
    setToken('stored');
    me.mockResolvedValue(makeSessionUser());
    setup();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));
    act(() => {
      window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
    });
    expect(screen.getByTestId('status')).toHaveTextContent('anonymous');
    expect(screen.getByText('Your session has expired. Please sign in again.')).toBeInTheDocument();
  });
});
