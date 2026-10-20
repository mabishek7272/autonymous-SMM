import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Hand, X } from 'lucide-react';
import { useAuth } from '../../auth/useAuth';
import { agents } from '../../services/api';
import { getErrorMessage } from '../../services/http';
import type { Approval, ApprovalDecisionResponse } from '../../types';
import { Badge, Button, Card, EmptyState, ErrorState, Modal, SkeletonList, Textarea, useToast } from '../../ui';
import { payloadText } from './format';
import { usePendingApprovals } from './hooks';

type Decision = 'approved' | 'rejected';

const RISK_TONE = { low: 'success', medium: 'warning', high: 'danger' } as const;

function resultSummary(item: Approval): { ok: boolean; text: string } {
  const result = item.result;
  const detail = payloadText(result, ['message', 'summary', 'error', 'reason']);
  if (item.status === 'failed') return { ok: false, text: detail ?? 'The action failed on the server.' };
  if (item.status === 'executed') return { ok: true, text: detail ?? 'The action was executed.' };
  if (item.status === 'rejected') return { ok: true, text: 'Rejected. Nothing was executed.' };
  return { ok: true, text: `Status: ${item.status}.` };
}

export function ApprovalQueue({ enabled }: { enabled: boolean }) {
  const { hasPermission } = useAuth();
  const canDecide = hasPermission('approvals:decide');
  const canDecideHigh = hasPermission('approvals:decide_high_risk');
  const toast = useToast();
  const qc = useQueryClient();
  const q = usePendingApprovals(enabled);
  const [target, setTarget] = useState<{ item: Approval; decision: Decision } | null>(null);
  const [note, setNote] = useState('');
  const [last, setLast] = useState<{ title: string; ok: boolean; text: string } | null>(null);

  const decide = useMutation<ApprovalDecisionResponse, unknown, { id: string; decision: Decision; note: string }>({
    mutationFn: ({ id, decision, note: n }) => agents.decideApproval(id, decision, n.trim() || undefined),
    onSuccess: (res, vars) => {
      const s = resultSummary(res.item);
      const title = target?.item.title ?? res.item.title;
      setLast({ title, ok: s.ok, text: s.text });
      if (!s.ok) toast.error(`${title}: ${s.text}`);
      else toast.success(vars.decision === 'approved' ? `Approved: ${title}. ${s.text}` : `Rejected: ${title}`);
      setTarget(null);
      setNote('');
      void qc.invalidateQueries({ queryKey: ['agents'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  const open = (item: Approval, decision: Decision) => {
    setNote('');
    setTarget({ item, decision });
  };
  const close = () => {
    if (!decide.isPending) setTarget(null);
  };
  const items = q.data ?? [];

  return (
    <Card className="ov-approvals" aria-labelledby="ov-approvals-title">
      <div className="ov-approvals__head">
        <Hand size={17} aria-hidden="true" />
        <h2 className="ov-card-title" id="ov-approvals-title">
          Founder Approval Queue
        </h2>
        <span className="ov-approvals__sub">Sensitive actions paused by the agents until you decide</span>
      </div>
      {q.isLoading ? (
        <SkeletonList rows={2} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} title="Could not load the approval queue" />
      ) : items.length === 0 ? (
        <EmptyState title="Queue clear" description="Agents are running autonomously. Nothing is waiting for you." />
      ) : (
        <div role="list">
          {items.map((ap) => {
            const blocked = ap.risk === 'high' && !canDecideHigh;
            const whyId = `ov-ap-${ap.id}`;
            return (
              <div key={ap.id} className="ov-approval" role="listitem">
                <span className="ov-approval__agent">{ap.agentId}</span>
                <div>
                  <div className="ov-approval__title">{ap.title}</div>
                  {ap.reason && <div className="ov-approval__why">{ap.reason}</div>}
                  {blocked && (
                    <div className="ov-approval__why ov-approval__why--warn" id={whyId}>
                      High-risk action: needs a user with the high-risk approval permission.
                    </div>
                  )}
                </div>
                <Badge tone={RISK_TONE[ap.risk]} uppercase>
                  {ap.risk} risk
                </Badge>
                <div className="ov-approval__actions">
                  {canDecide ? (
                    <>
                      <Button variant="secondary" size="md" disabled={blocked} aria-describedby={blocked ? whyId : undefined} aria-label={`Reject: ${ap.title}`} onClick={() => open(ap, 'rejected')}>
                        Reject
                      </Button>
                      <Button variant="primary" size="md" disabled={blocked} aria-describedby={blocked ? whyId : undefined} aria-label={`Approve: ${ap.title}`} onClick={() => open(ap, 'approved')}>
                        Approve
                      </Button>
                    </>
                  ) : (
                    <span className="ov-hint">View only</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {last && (
        <div className={`ov-result${last.ok ? '' : ' ov-result--bad'}`} role="status">
          <span>
            <strong>{last.title}</strong>: {last.text}
          </span>
          <Button variant="ghost" size="sm" iconOnly aria-label="Dismiss result" onClick={() => setLast(null)}>
            <X size={13} aria-hidden="true" />
          </Button>
        </div>
      )}
      <Modal
        open={target !== null}
        onClose={close}
        title={target?.decision === 'approved' ? 'Approve this action?' : 'Reject this action?'}
        subtitle={target?.item.title}
        width={460}
        footer={
          <>
            <Button variant="secondary" onClick={close} disabled={decide.isPending}>
              Cancel
            </Button>
            <Button
              variant={target?.decision === 'rejected' ? 'danger' : 'primary'}
              icon={target?.decision === 'approved' ? <Check size={13} aria-hidden="true" /> : <X size={13} aria-hidden="true" />}
              loading={decide.isPending}
              onClick={() => target && decide.mutate({ id: target.item.id, decision: target.decision, note })}
            >
              {target?.decision === 'approved' ? 'Approve and run' : 'Reject'}
            </Button>
          </>
        }
      >
        {target?.decision === 'approved' && <p className="ov-hint" style={{ marginBottom: 10 }}>Approving executes the action immediately.</p>}
        <Textarea label="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={500} />
      </Modal>
    </Card>
  );
}
