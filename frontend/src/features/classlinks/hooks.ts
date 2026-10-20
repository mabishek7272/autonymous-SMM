import { useQuery } from '@tanstack/react-query';
import { api } from '../../services/api';

export const classLinkKeys = {
  list: ['class-links'] as const,
  batches: ['teacher', 'batches'] as const, // shared with the Teacher Portal so both stay in sync
};

export function useClassLinks() {
  return useQuery({ queryKey: classLinkKeys.list, queryFn: ({ signal }) => api.classLinks.list({ signal }) });
}

export function useBatchesForLinks() {
  return useQuery({ queryKey: classLinkKeys.batches, queryFn: ({ signal }) => api.academic.batches({ signal }) });
}
