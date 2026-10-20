import { ClipboardList, GraduationCap, Layers, Link2, ShieldCheck, Terminal, Users, FileText, type LucideIcon } from 'lucide-react';
import type { Permission } from '../types';

export interface NavTab {
  path: string;
  label: string;
  icon: LucideIcon;
  permission: Permission;
}

/** Order matches the header. A tab is visible only when the user holds its permission. */
export const NAV_TABS: readonly NavTab[] = [
  { path: '/admissions', label: 'Admissions', icon: Layers, permission: 'leads:manage' },
  { path: '/students', label: 'Student Health', icon: GraduationCap, permission: 'students:read' },
  { path: '/teachers', label: 'Teachers', icon: ClipboardList, permission: 'attendance:mark' },
  { path: '/class-links', label: 'Class Links', icon: Link2, permission: 'classlinks:manage' },
  { path: '/reports', label: 'Reports', icon: FileText, permission: 'reports:review' },
  { path: '/overview', label: 'Overview', icon: ShieldCheck, permission: 'dashboard:view' },
  { path: '/admin', label: 'Users', icon: Users, permission: 'users:manage' },
  { path: '/dev', label: 'Dev Console', icon: Terminal, permission: 'dev:console' },
];

export function allowedTabs(hasPermission: (p: Permission) => boolean): NavTab[] {
  return NAV_TABS.filter((t) => hasPermission(t.permission));
}

/** First tab the user may see, or null when their role has no section at all. */
export function firstAllowedPath(hasPermission: (p: Permission) => boolean): string | null {
  return allowedTabs(hasPermission)[0]?.path ?? null;
}
