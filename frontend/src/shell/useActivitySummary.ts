import { useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { agents } from '../services/api';

const SEEN_KEY = 'ekalavya_activity_seen';
export const ACTIVITY_LIMIT = 100;

function readSeen(): string | null {
  try {
    return window.localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}

function writeSeen(value: string): void {
  try {
    window.localStorage.setItem(SEEN_KEY, value);
  } catch {
    /* per-viewer convenience only */
  }
}

export interface ActivitySummary {
  /** Entries returned by the backend (capped at ACTIVITY_LIMIT). */
  total: number;
  /** True when the backend may hold more entries than were fetched. */
  capped: boolean;
  /** Entries newer than the last time this viewer opened the drawer. */
  unread: number;
  isLoading: boolean;
  isError: boolean;
  markSeen: () => void;
}

/** Real counts for the header Logs button, from GET /agents/activity-log. Only runs when enabled (agents:view). */
export function useActivitySummary(enabled: boolean): ActivitySummary {
  const [seen, setSeen] = useState<string | null>(readSeen);
  const query = useQuery({
    queryKey: ['agents', 'activity-log', 'summary', ACTIVITY_LIMIT],
    queryFn: ({ signal }) => agents.activityLog({ limit: ACTIVITY_LIMIT }, { signal }),
    enabled,
    refetchInterval: 30_000,
  });
  const logs = query.data ?? [];
  const newest = logs.reduce<string | null>((max, l) => (max === null || l.timestamp > max ? l.timestamp : max), null);
  const unread = seen === null ? logs.length : logs.filter((l) => l.timestamp > seen).length;

  const markSeen = useCallback(() => {
    if (newest) {
      writeSeen(newest);
      setSeen(newest);
    }
  }, [newest]);

  return {
    total: logs.length,
    capped: logs.length >= ACTIVITY_LIMIT,
    unread,
    isLoading: query.isLoading,
    isError: query.isError,
    markSeen,
  };
}
