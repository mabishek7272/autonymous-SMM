import type { ReactNode } from 'react';
import type { Permission } from '../types';
import { useAuth } from './useAuth';

interface RequirePermissionProps {
  /** A single permission, or several (the user needs at least one when `mode` is "any", all when "all"). */
  permission: Permission | readonly Permission[];
  mode?: 'any' | 'all';
  /** Rendered when the permission is missing. Defaults to nothing. */
  fallback?: ReactNode;
  children: ReactNode;
}

/** Renders children only when the logged-in user holds the permission(s) returned by GET /auth/me. */
export function RequirePermission({ permission, mode = 'any', fallback = null, children }: RequirePermissionProps) {
  const { hasPermission } = useAuth();
  const list = typeof permission === 'string' ? [permission] : permission;
  const allowed = mode === 'all' ? list.every(hasPermission) : list.some(hasPermission);
  return <>{allowed ? children : fallback}</>;
}
