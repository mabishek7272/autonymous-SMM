import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { agents } from '../../services/api';

/** Flips to true after first paint so bars and arcs animate from 0 to their size. */
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);
  return mounted;
}

/** Pending approvals (GET /agents/approval-queue?status=pending); shared by the page chip and the queue. */
export function usePendingApprovals(enabled: boolean) {
  return useQuery({
    queryKey: ['agents', 'approval-queue', 'pending'],
    queryFn: ({ signal }) => agents.approvalQueue('pending', { signal }),
    enabled,
    refetchInterval: 30_000,
  });
}
