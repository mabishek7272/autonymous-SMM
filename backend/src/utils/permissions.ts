import { UserRole } from '@prisma/client';
import { prisma } from './database';

/**
 * Single source of truth for who can do what.
 * The frontend receives the caller's permission list from GET /auth/me,
 * so tab/button visibility and API enforcement can never drift apart.
 */
export type Permission =
  | 'users:manage'
  | 'leads:manage'
  | 'students:read'
  | 'students:manage'
  | 'academics:manage'
  | 'attendance:mark'
  | 'sessions:manage'
  | 'classlinks:manage'
  | 'reports:review'
  | 'reminders:manage'
  | 'dashboard:view'
  | 'agents:view'
  | 'agents:run'
  | 'approvals:decide'
  | 'approvals:decide_high_risk'
  | 'dev:console'
  | 'portal:view';

const ALL: Permission[] = [
  'users:manage', 'leads:manage', 'students:read', 'students:manage', 'academics:manage',
  'attendance:mark', 'sessions:manage', 'classlinks:manage', 'reports:review', 'reminders:manage', 'dashboard:view',
  'agents:view', 'agents:run', 'approvals:decide', 'approvals:decide_high_risk', 'dev:console',
];

export const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  superadmin: ALL,
  admin: ALL.filter((p) => p !== 'dev:console' && p !== 'approvals:decide_high_risk'),
  manager: [
    'leads:manage', 'students:read', 'students:manage', 'academics:manage', 'attendance:mark',
    'sessions:manage', 'classlinks:manage', 'reports:review', 'reminders:manage', 'dashboard:view', 'agents:view',
  ],
  // Teachers only ever see their own batches (enforced by the scope helpers below).
  teacher: ['students:read', 'attendance:mark', 'sessions:manage', 'academics:manage'],
  // Customer-facing accounts: read-only, self-scoped only. ownStudentIds() below is what
  // actually enforces "own data only" — this permission just gates reaching /portal/* at all.
  parent: ['portal:view'],
  student: ['portal:view'],
};

export function can(role: UserRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/** Roles that hold a permission — used to build `authorize(...)` guards. */
export function rolesWith(permission: Permission): UserRole[] {
  return (Object.keys(ROLE_PERMISSIONS) as UserRole[]).filter((r) => can(r, permission));
}

/** Roles that see every batch/student; teachers are limited to their own batches. */
export function isBatchScoped(role: UserRole): boolean {
  return role === 'teacher';
}

export async function teacherBatchIds(userId: string): Promise<string[]> {
  const batches = await prisma.batch.findMany({ where: { teacherId: userId }, select: { id: true } });
  return batches.map((b) => b.id);
}

export async function canAccessBatch(user: { userId: string; role: UserRole }, batchId: string): Promise<boolean> {
  if (!isBatchScoped(user.role)) return true;
  const batch = await prisma.batch.findFirst({ where: { id: batchId, teacherId: user.userId }, select: { id: true } });
  return !!batch;
}

export async function canAccessStudent(user: { userId: string; role: UserRole }, studentId: string): Promise<boolean> {
  if (!isBatchScoped(user.role)) return true;
  const link = await prisma.enrollment.findFirst({
    where: { studentId, batch: { teacherId: user.userId } },
    select: { id: true },
  });
  return !!link;
}

/** Student IDs the caller may see: all of their children if `parent`, just themself if `student`. */
export async function ownStudentIds(user: { role: UserRole; parentId?: string | null; studentId?: string | null }): Promise<string[]> {
  if (user.role === 'student') return user.studentId ? [user.studentId] : [];
  if (user.role === 'parent') {
    if (!user.parentId) return [];
    const students = await prisma.student.findMany({ where: { parentId: user.parentId }, select: { id: true } });
    return students.map((s) => s.id);
  }
  return [];
}
