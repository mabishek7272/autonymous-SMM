import { useState } from 'react';
import { Badge, ErrorState, Skeleton } from '../../ui';
import type { CallLog } from '../../types';
import { formatDateTime } from './helpers';
import { formatDuration, outcomeBadge } from './call-helpers';
import { useLeadCalls } from './useAdmissions';

function CallRow({ call }: { call: CallLog }) {
  const [open, setOpen] = useState(false);
  const badge = outcomeBadge(call.outcome);
  const turns = Array.isArray(call.transcript) ? call.transcript : [];
  const panelId = `call-transcript-${call.id}`;
  return (
    <li className="adm-call">
      <div className="adm-call__head">
        <span>{formatDateTime(call.createdAt)}</span>
        <span className="adm-call__dur">{formatDuration(call.durationSec)}</span>
        <Badge tone={badge.tone}>{badge.label}</Badge>
      </div>
      {call.summary ? <p className="adm-call__summary">{call.summary}</p> : <p className="adm-call__summary adm-call__summary--none">No summary recorded.</p>}
      {turns.length > 0 ? (
        <>
          <button type="button" className="adm-call__toggle" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((v) => !v)}>
            {open ? 'Hide transcript' : `Show transcript (${turns.length} turns)`}
          </button>
          {open && (
            <div id={panelId} className="adm-call__transcript" role="log" aria-label="Call transcript">
              {turns.map((t, i) => (
                <div key={i} className={`adm-call__turn adm-call__turn--${t.role}`}>
                  <strong>{t.role === 'agent' ? 'Assistant' : 'Caller'}:</strong> {t.text}
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <span className="adm-call__summary adm-call__summary--none">No transcript recorded.</span>
      )}
    </li>
  );
}

export function LeadCalls({ leadId }: { leadId: string }) {
  const calls = useLeadCalls(leadId);
  return (
    <section aria-label="Calls">
      <h3 className="adm-section-title" style={{ marginBottom: 8 }}>
        Calls
      </h3>
      {calls.isPending ? (
        <Skeleton height={48} radius={12} />
      ) : calls.isError ? (
        <ErrorState error={calls.error} onRetry={() => void calls.refetch()} retrying={calls.isFetching} title="Could not load calls" />
      ) : calls.data.data.length === 0 ? (
        <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-muted)' }}>No calls with this lead yet.</p>
      ) : (
        <ul className="adm-calls">
          {calls.data.data.map((c) => (
            <CallRow key={c.id} call={c} />
          ))}
        </ul>
      )}
    </section>
  );
}
