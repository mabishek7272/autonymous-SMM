import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AlertCircle, Bot, CheckCircle2, Clock, Download } from 'lucide-react';
import { agents } from '../../services/api';
import { getErrorMessage } from '../../services/http';
import { ACTIVITY_LIMIT } from '../../shell/useActivitySummary';
import type { AiActivityLog } from '../../types';
import { Badge, Button, Drawer, EmptyState, ErrorState, SkeletonList, cx, useToast } from '../../ui';
import { humanizeAction, payloadText, relativeTime } from './format';
import './overview.css';

interface ActivityDrawerProps {
  open: boolean;
  onClose: () => void;
}

const FAILED = '__failed__';
const STATUS_TONE = { success: 'success', failure: 'danger', pending: 'warning' } as const;
const STATUS_LABEL = { success: 'Success', failure: 'Failed', pending: 'Pending' } as const;
const STATUS_ICON = { success: CheckCircle2, failure: AlertCircle, pending: Clock } as const;

/** Triggers a browser download of text fetched with the auth header (no window.open). */
function saveCsv(text: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function ActivityItem({ log }: { log: AiActivityLog }) {
  const Icon = STATUS_ICON[log.status] ?? Bot;
  const detail = payloadText(log.payload);
  return (
    <li className="ov-act">
      <div className={cx('ov-act__icon', log.status === 'failure' && 'ov-act__icon--failure', log.status === 'pending' && 'ov-act__icon--pending')}>
        <Icon size={14} aria-hidden="true" />
      </div>
      <div className="ov-act__body">
        <div className="ov-act__top">
          <span className="ov-act__agent">{log.agentId}</span>
          <time className="ov-act__time" dateTime={log.timestamp} title={new Date(log.timestamp).toLocaleString()}>
            {relativeTime(log.timestamp)}
          </time>
        </div>
        <span className="ov-act__text">
          {humanizeAction(log.actionType)}
          {detail ? `: ${detail}` : ''}
        </span>
        <Badge tone={STATUS_TONE[log.status] ?? 'neutral'} uppercase style={{ alignSelf: 'flex-start' }}>
          {STATUS_LABEL[log.status] ?? log.status}
        </Badge>
      </div>
    </li>
  );
}

export default function ActivityDrawer({ open, onClose }: ActivityDrawerProps) {
  const toast = useToast();
  const [filter, setFilter] = useState<string>('all');
  // Same key as the header summary: one shared cache entry; polling only while the drawer is open.
  const q = useQuery({
    queryKey: ['agents', 'activity-log', 'summary', ACTIVITY_LIMIT],
    queryFn: ({ signal }) => agents.activityLog({ limit: ACTIVITY_LIMIT }, { signal }),
    enabled: open,
    refetchInterval: open ? 15_000 : false,
  });
  const logs = useMemo(() => q.data ?? [], [q.data]);

  const pills = useMemo(() => {
    const counts = new Map<string, number>();
    for (const l of logs) counts.set(l.agentId, (counts.get(l.agentId) ?? 0) + 1);
    const failed = logs.filter((l) => l.status === 'failure').length;
    return {
      failed,
      agents: [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id),
    };
  }, [logs]);

  const visible = filter === 'all' ? logs : filter === FAILED ? logs.filter((l) => l.status === 'failure') : logs.filter((l) => l.agentId === filter);

  const exportCsv = useMutation({
    mutationFn: () => agents.exportActivityLog(),
    onSuccess: (text) => {
      saveCsv(text, `activity-log-${new Date().toISOString().slice(0, 10)}.csv`);
      toast.success('Activity log exported.');
    },
    onError: (err) => toast.error(`Export failed: ${getErrorMessage(err)}`),
  });

  const pill = (value: string, label: string) => (
    <button key={value} type="button" className="ov-pill" aria-pressed={filter === value} onClick={() => setFilter(value)}>
      {label}
    </button>
  );

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Activity Stream"
      titleExtra={
        <span className="ov-live">
          <span className="ov-live__dot" aria-hidden="true" />
          live
        </span>
      }
      headerContent={
        logs.length > 0 ? (
          <div className="ov-pills" role="group" aria-label="Filter activity">
            {pill('all', 'All')}
            {pills.agents.map((id) => pill(id, id))}
            {pills.failed > 0 && pill(FAILED, `Failed (${pills.failed})`)}
          </div>
        ) : undefined
      }
    >
      <div className="ov-drawer-tools">
        <span>
          Latest {ACTIVITY_LIMIT} entries · refreshes every 15s
        </span>
        <Button variant="secondary" size="sm" icon={<Download size={12} aria-hidden="true" />} loading={exportCsv.isPending} onClick={() => exportCsv.mutate()}>
          Export CSV
        </Button>
      </div>
      {q.isLoading ? (
        <div style={{ padding: '0 18px' }}>
          <SkeletonList rows={5} rowHeight={56} label="Loading activity" />
        </div>
      ) : q.isError ? (
        <div style={{ padding: '0 18px' }}>
          <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} title="Could not load activity" />
        </div>
      ) : visible.length === 0 ? (
        <div style={{ padding: '0 18px' }}>
          <EmptyState title={logs.length === 0 ? 'No activity yet' : 'Nothing matches this filter'} description={logs.length === 0 ? 'Agent actions will appear here as they happen.' : undefined} />
        </div>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} aria-label="Agent activity">
          {visible.map((l) => (
            <ActivityItem key={l.id} log={l} />
          ))}
        </ul>
      )}
    </Drawer>
  );
}
