import { createContext } from 'react';
import type { LoginOtpChallenge, Permission, SessionUser } from '../types';

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous' | 'error';

export interface AuthContextValue {
  /** loading = verifying a stored token; error = /auth/me failed for a reason other than an invalid token. */
  status: AuthStatus;
  user: SessionUser | null;
  permissions: readonly Permission[];
  /** Message of the failed /auth/me request when status is 'error'. */
  error: string | null;
  /** Step 1: email + password. Never completes the session; emails a code and returns a challenge for step 2. */
  login: (email: string, password: string) => Promise<LoginOtpChallenge>;
  /** Step 2: redeems the code and completes the session. */
  verifyOtp: (challenge: LoginOtpChallenge, code: string) => Promise<void>;
  /** Invalidates the current code and gets a fresh challenge for the same pending login. */
  resendOtp: (challenge: LoginOtpChallenge) => Promise<LoginOtpChallenge>;
  logout: () => void;
  /** Re-runs the /auth/me check (used by the Retry button on the error screen). */
  retry: () => void;
  hasPermission: (permission: Permission) => boolean;
  hasAnyPermission: (permissions: readonly Permission[]) => boolean;
}

export const AuthContext = createContext<AuthContextValue | null>(null);
