/**
 * Identical to backend/src/utils/permissions.ts. The backend returns the caller's
 * permission list from GET /auth/me and POST /auth/login; the UI gates on these,
 * never on role names.
 */
export const PERMISSIONS = [
  'users:manage',
  'leads:manage',
  'students:read',
  'students:manage',
  'academics:manage',
  'attendance:mark',
  'sessions:manage',
  'classlinks:manage',
  'reports:review',
  'reminders:manage',
  'dashboard:view',
  'agents:view',
  'agents:run',
  'approvals:decide',
  'approvals:decide_high_risk',
  'dev:console',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = ['superadmin', 'admin', 'manager', 'teacher'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  superadmin: 'Super Admin',
  admin: 'Admin',
  manager: 'Manager',
  teacher: 'Teacher',
};
