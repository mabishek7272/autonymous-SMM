import { CalendarClock, ExternalLink } from 'lucide-react';
import { Badge, Card, CardHeader, EmptyState, ErrorState, SkeletonList } from '../../ui';
import { formatIstDateTime, formatIstTime } from './dates';
import { useTodaySessions } from './hooks';

function safeHttpsUrl(url: string): string | null {
  try {
    return new URL(url).protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/** Read-only overview of today's class links across batches. */
export function TodaySessionsSection() {
  const q = useTodaySessions(true);
  const sessions = q.data ?? [];

  return (
    <Card aria-labelledby="rp-sessions-title">
      <CardHeader
        title={<span id="rp-sessions-title">Today's class links across batches</span>}
        subtitle="Read-only view of the meeting links and whether parents have been told."
      />
      {q.isLoading ? (
        <SkeletonList rows={3} />
      ) : q.isError ? (
        <ErrorState error={q.error} title="Could not load today's classes" onRetry={() => void q.refetch()} retrying={q.isRefetching} />
      ) : sessions.length === 0 ? (
        <EmptyState icon={<CalendarClock size={22} aria-hidden="true" />} title="No classes scheduled today" description="Sessions created for today will appear here with their meeting links." />
      ) : (
        <div className="ek-table-wrap">
          <table className="ek-table">
            <caption className="ek-sr-only">Today's class sessions</caption>
            <thead>
              <tr>
                <th>Time (IST)</th>
                <th>Batch</th>
                <th>Topic</th>
                <th className="is-right">Duration</th>
                <th>Meeting link</th>
                <th>Announced</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => {
                const href = safeHttpsUrl(s.meetingUrl);
                return (
                  <tr key={s.id}>
                    <td>{formatIstTime(s.startsAt)}</td>
                    <td>{s.batch.batchName ?? 'Unnamed batch'}</td>
                    <td>{s.topic ?? '—'}</td>
                    <td className="is-right">{s.durationMinutes} min</td>
                    <td>
                      {href ? (
                        <a className="rp-link" href={href} target="_blank" rel="noopener noreferrer" aria-label={`Open meeting link for ${s.batch.batchName ?? 'batch'}`}>
                          Open link <ExternalLink size={12} aria-hidden="true" />
                        </a>
                      ) : (
                        <span>—</span>
                      )}
                    </td>
                    <td>
                      {s.announcedAt ? (
                        <Badge tone="success">{`Announced ${formatIstDateTime(s.announcedAt)}`}</Badge>
                      ) : (
                        <Badge tone="warning">Not announced</Badge>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
