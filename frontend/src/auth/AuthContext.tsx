import { useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { auth as authApi } from '../services/api';
import { getErrorMessage, isApiError } from '../services/http';
import type { LoginOtpChallenge, Permission, SessionUser } from '../types';
import { ToastContext } from '../ui/toast-context';
import { AuthContext, type AuthContextValue, type AuthStatus } from './auth-context';
import { SESSION_EXPIRED_EVENT, clearToken, getToken, setToken } from './session';

/**
 * Owns the session: token in localStorage ('ekalavya_token'), user + permissions from GET /auth/me,
 * login/logout, and reaction to the 'session-expired' event raised by the http layer on a 401.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const toast = useContext(ToastContext);
  const [status, setStatus] = useState<AuthStatus>(() => (getToken() ? 'loading' : 'anonymous'));
  const [user, setUser] = useState<SessionUser | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // Verify a stored token on load (and on retry).
  useEffect(() => {
    if (!getToken()) return;
    const controller = new AbortController();
    authApi
      .me({ signal: controller.signal })
      .then((me) => {
        setUser(me);
        setError(null);
        setStatus('authenticated');
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        if (isApiError(err) && err.status === 401) {
          clearToken();
          setUser(null);
          setStatus('anonymous');
          return;
        }
        setError(getErrorMessage(err));
        setStatus('error');
      });
    return () => controller.abort();
  }, [attempt]);

  // 401 anywhere: drop the session and send the user to /login.
  useEffect(() => {
    const onExpired = () => {
      setUser(null);
      setStatus('anonymous');
      queryClient.clear();
      toast?.info('Your session has expired. Please sign in again.');
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, [queryClient, toast]);

  // Step 1: email + password. Never sets a session — the server emails a code and hands back a challenge.
  const login = useCallback(async (email: string, password: string) => authApi.login(email, password), []);

  // Step 2: redeem the code. Only this (and a successful stored-token check) ever completes the session.
  const completeSession = useCallback(
    async (res: { token: string }) => {
      setToken(res.token);
      try {
        const me = await authApi.me();
        queryClient.clear();
        setUser(me);
        setError(null);
        setStatus('authenticated');
      } catch (err) {
        clearToken();
        throw err;
      }
    },
    [queryClient],
  );

  const verifyOtp = useCallback(
    async (challenge: LoginOtpChallenge, code: string) => {
      const res = await authApi.verifyOtp(challenge.otpToken, code);
      await completeSession(res);
    },
    [completeSession],
  );

  const resendOtp = useCallback(async (challenge: LoginOtpChallenge) => authApi.resendOtp(challenge.otpToken), []);

  const logout = useCallback(() => {
    clearToken();
    queryClient.clear();
    setUser(null);
    setError(null);
    setStatus('anonymous');
  }, [queryClient]);

  const retry = useCallback(() => {
    setStatus('loading');
    setAttempt((n) => n + 1);
  }, []);

  const value = useMemo<AuthContextValue>(() => {
    const permissions: readonly Permission[] = user?.permissions ?? [];
    return {
      status,
      user,
      permissions,
      error,
      login,
      verifyOtp,
      resendOtp,
      logout,
      retry,
      hasPermission: (p) => permissions.includes(p),
      hasAnyPermission: (ps) => ps.some((p) => permissions.includes(p)),
    };
  }, [status, user, error, login, verifyOtp, resendOtp, logout, retry]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
