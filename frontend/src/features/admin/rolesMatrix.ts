import { PERMISSIONS, ROLES, type Permission, type Role } from '../../types/permissions';

/**
 * Typed mirror of ROLE_PERMISSIONS in backend/src/utils/permissions.ts, used only for the
 * read-only roles legend. Real gating always uses the list returned by GET /auth/me.
 * rolesMatrix.test.ts keeps this in step with the permission names the app uses.
 */
const ALL: readonly Permission[] = PERMISSIONS;

export const ROLE_MATRIX: Record<Role, readonly Permission[]> = {
  superadmin: ALL,
  admin: ALL.filter((p) => p !== 'dev:console' && p !== 'approvals:decide_high_risk'),
  manager: [
    'leads:manage', 'students:read', 'students:manage', 'academics:manage', 'attendance:mark',
    'sessions:manage', 'classlinks:manage', 'reports:review', 'reminders:manage', 'dashboard:view', 'agents:view',
  ],
  teacher: ['students:read', 'attendance:mark', 'sessions:manage', 'academics:manage'],
};

export const PERMISSION_LABELS: Record<Permission, string> = {
  'users:manage': 'Manage users',
  'leads:manage': 'Manage leads and admissions',
  'students:read': 'View students',
  'students:manage': 'Manage students',
  'academics:manage': 'Manage academics',
  'attendance:mark': 'Mark attendance',
  'sessions:manage': 'Manage class sessions',
  'classlinks:manage': 'Manage class link library and schedules',
  'reports:review': 'Review progress reports',
  'reminders:manage': 'Manage reminders',
  'dashboard:view': 'View dashboard',
  'agents:view': 'View AI agent activity',
  'agents:run': 'Run AI agents',
  'approvals:decide': 'Decide approvals',
  'approvals:decide_high_risk': 'Decide high-risk approvals',
  'dev:console': 'Developer console',
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  superadmin: 'Full access, including the developer console and creating other superadmins.',
  admin: 'Runs the institute: everything except the developer console and high-risk approvals.',
  manager: 'Day-to-day operations across admissions, students, academics and reports.',
  teacher: 'Sees only their own batches: attendance, sessions and academics.',
};

/** Roles the acting user may assign. Mirrors the backend rule: only a superadmin grants superadmin. */
export function grantableRoles(actor: Role | undefined): readonly Role[] {
  return actor === 'superadmin' ? ROLES : ROLES.filter((r) => r !== 'superadmin');
}
