import { useContext } from 'react';
import { AuthContext, type AuthContextValue } from './auth-context';

/** Current session: user, permissions, login/logout and hasPermission(...). */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
