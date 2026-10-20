import { useQuery } from '@tanstack/react-query';
import { api } from '../../services/api';

export const reportKeys = {
  list: (weekStart: string, batchId: string) => ['reports', 'list', weekStart, batchId] as const,
  approvedAll: ['reports', 'approved-all'] as const,
  all: ['reports'] as const,
  rules: ['reminders'] as const,
  todaySessions: ['sessions', 'today'] as const,
  batches: ['reports-view', 'batches'] as const,
};

export function useReportList(weekStart: string, batchId: string, enabled: boolean) {
  return useQuery({
    queryKey: reportKeys.list(weekStart, batchId),
    queryFn: ({ signal }) => api.reports.list({ weekStart, batchId: batchId || undefined }, { signal }),
    enabled,
  });
}

/** Every approved report regardless of week: this is what "send all approved" will actually send. */
export function useApprovedReports(enabled: boolean) {
  return useQuery({
    queryKey: reportKeys.approvedAll,
    queryFn: ({ signal }) => api.reports.list({ status: 'approved' }, { signal }),
    enabled,
  });
}

export function useBatchOptions(enabled: boolean) {
  return useQuery({
    queryKey: reportKeys.batches,
    queryFn: ({ signal }) => api.academic.batches({ signal }),
    enabled,
  });
}

export function useReminderRules(enabled: boolean) {
  return useQuery({ queryKey: reportKeys.rules, queryFn: ({ signal }) => api.reminders.list({ signal }), enabled });
}

export function useTodaySessions(enabled: boolean) {
  return useQuery({ queryKey: reportKeys.todaySessions, queryFn: ({ signal }) => api.sessions.today({ signal }), enabled });
}
