import { useQueries, useQuery } from '@tanstack/react-query';
import { api } from '../../services/api';
import type { AttendanceRoster, BatchDetail } from '../../types';

export const teacherKeys = {
  batches: ['teacher', 'batches'] as const,
  sessionsToday: ['teacher', 'sessions-today'] as const,
  roster: (batchId: string, date: string) => ['teacher', 'roster', batchId, date] as const,
  sessions: (batchId: string) => ['teacher', 'sessions', batchId] as const,
  students: (batchId: string) => ['teacher', 'students', batchId] as const,
  summary: (studentId: string) => ['teacher', 'summary', studentId] as const,
  history: (studentId: string, from: string, to: string) => ['teacher', 'history', studentId, from, to] as const,
};

export function useBatches() {
  return useQuery({ queryKey: teacherKeys.batches, queryFn: ({ signal }) => api.academic.batches({ signal }) });
}

export function useSessionsToday(enabled: boolean) {
  return useQuery({ queryKey: teacherKeys.sessionsToday, queryFn: ({ signal }) => api.sessions.today({ signal }), enabled });
}

export interface BatchAttendanceToday {
  batchId: string;
  loading: boolean;
  failed: boolean;
  roster: AttendanceRoster | null;
}

/** Today's roster for every batch (shares cache keys with the attendance tab). */
export function useTodayRosters(batches: readonly BatchDetail[], today: string, enabled: boolean): BatchAttendanceToday[] {
  return useQueries({
    queries: batches.map((b) => ({
      queryKey: teacherKeys.roster(b.id, today),
      queryFn: ({ signal }: { signal: AbortSignal }) => api.attendance.roster(b.id, today, { signal }),
      enabled,
    })),
    combine: (results) =>
      results.map((r, i) => ({
        batchId: batches[i].id,
        loading: r.isPending && enabled,
        failed: r.isError,
        roster: r.data ?? null,
      })),
  });
}

export function countRoster(roster: AttendanceRoster | null): { total: number; marked: number; present: number } {
  if (!roster) return { total: 0, marked: 0, present: 0 };
  let marked = 0;
  let present = 0;
  for (const r of roster.roster) {
    if (r.status !== null) marked += 1;
    if (r.status === 'present' || r.status === 'late') present += 1;
  }
  return { total: roster.roster.length, marked, present };
}
