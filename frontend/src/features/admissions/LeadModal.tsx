import { LEAD_TIMELINE_LABELS } from '../../types/models';
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { messages as messagesApi } from '../../services/api';
import { Avatar, Badge, Button, ErrorState, Modal, Skeleton, Textarea, useToast } from '../../ui';
import { nextStageLabel, nextStatus, stageLabel, type LeadStatus } from '../../types/lead-stages';
import type { LeadWithParent } from '../../types';
import { academicLine, formatDateTime, leadName, sourceLabel, timeAgo } from './helpers';
import { useLeadDetail, useLeadMessages } from './useAdmissions';
import { LeadCalls } from './LeadCalls';

interface LeadModalProps {
  lead: LeadWithParent;
  /** Focus the message composer on open (the card's Message button). */
  focusComposer: boolean;
  canMove: boolean;
  moving: boolean;
  onClose: () => void;
  onMove: (lead: LeadWithParent, to: LeadStatus) => void;
  onBookDemo: (lead: LeadWithParent) => void;
}

const APPT_TONE = { scheduled: 'primary', completed: 'success', cancelled: 'neutral', no_show: 'danger' } as const;

export function LeadModal({ lead: listLead, focusComposer, canMove, moving, onClose, onMove, onBookDemo }: LeadModalProps) {
  const qc = useQueryClient();
  const toast = useToast();
  const detail = useLeadDetail(listLead.id);
  const history = useLeadMessages(listLead.id);
  // The board copy carries the live (optimistic) status; the detail fetch adds all appointments.
  const lead: LeadWithParent = { ...(detail.data ?? listLead), status: listLead.status };
  const name = leadName(lead);
  const [text, setText] = useState('');
  const chatRef = useRef<HTMLDivElement>(null);

  const msgs = history.data?.data ?? [];
  const last = msgs.length ? msgs[msgs.length - 1] : null;

  useEffect(() => {
    if (focusComposer) document.getElementById('adm-composer')?.focus();
  }, [focusComposer]);

  useEffect(() => {
    const el = chatRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs.length]);

  const send = useMutation({
    mutationFn: (body: string) => messagesApi.sendToLead(lead.id, body),
    onSuccess: () => {
      toast.success(`Message queued for WhatsApp to ${name}`);
      setText('');
      void qc.invalidateQueries({ queryKey: ['admissions', 'messages', lead.id] });
    },
    onError: (err) => toast.fromError(err, 'Could not send message'),
  });

  const next = nextStatus(lead.status);
  const nextLabel = nextStageLabel(lead.status);
  const academic = academicLine(lead);
  const appts = [...(lead.appointments ?? [])].sort((a, b) => b.scheduledAt.localeCompare(a.scheduledAt));
  const info: [string, string | null][] = [
    ['Parent', name],
    ['WhatsApp', lead.parent.whatsappNumber],
    ['Email', lead.parent.email],
    ['Source', lead.source ? sourceLabel(lead.source) : null],
    ['Interested in', academic],
    ['Wants to start', lead.timeline ? LEAD_TIMELINE_LABELS[lead.timeline] : null],
    ['Requirements', lead.requirements],
    ['Notes', lead.notes],
    ['Created', formatDateTime(lead.createdAt)],
  ];

  return (
    <Modal
      open
      onClose={onClose}
      title={name}
      subtitle={<span style={{ fontFamily: 'var(--font-mono)' }}>{lead.parent.whatsappNumber}</span>}
      icon={<Avatar name={name} size={42} />}
      headerExtra={
        <Badge tone="warm" uppercase>
          {stageLabel(lead.status)}
        </Badge>
      }
      footer={
        <div className="adm-lead-foot">
          {lead.status !== 'lost' && (
            <Button variant="secondary" loading={moving} onClick={() => onMove(lead, 'lost')}>
              Mark Lost
            </Button>
          )}
          <span className="adm-lead-foot__spacer" />
          {lead.status !== 'converted' && lead.status !== 'lost' && (
            <Button variant="warm" onClick={() => onBookDemo(lead)}>
              Book Demo
            </Button>
          )}
          {canMove && next && nextLabel && (
            <Button loading={moving} onClick={() => onMove(lead, next)}>
              Move Stage ▸ {nextLabel}
            </Button>
          )}
        </div>
      }
    >
      {lead.aiScore !== null && (
        <div className="adm-lead-score">
          <div>
            <div className="adm-lead-score__num">{lead.aiScore}</div>
            <div className="adm-lead-score__cap">AI SCORE</div>
          </div>
        </div>
      )}

      <dl className="adm-info">
        {info
          .filter(([, v]) => !!v)
          .map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
      </dl>

      <section aria-label="Appointments">
        <h3 className="adm-section-title" style={{ marginBottom: 8 }}>
          Demo appointments
        </h3>
        {detail.isPending ? (
          <Skeleton height={20} />
        ) : appts.length === 0 ? (
          <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-muted)' }}>No demo booked yet.</p>
        ) : (
          <ul className="adm-appts">
            {appts.map((a) => (
              <li key={a.id}>
                <span>{formatDateTime(a.scheduledAt)}</span>
                <Badge tone={APPT_TONE[a.status]}>{a.status.replace('_', ' ')}</Badge>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="WhatsApp conversation">
        <div className="adm-section-head" style={{ marginBottom: 8 }}>
          <h3 className="adm-section-title">WhatsApp conversation</h3>
          {last && (
            <span className={`adm-reply${last.direction === 'outbound' ? ' adm-reply--wait' : ''}`}>
              {last.direction === 'inbound' ? 'Parent replied' : 'Awaiting reply'} · {timeAgo(last.createdAt)}
            </span>
          )}
        </div>
        {history.isPending ? (
          <Skeleton height={80} radius={14} />
        ) : history.isError ? (
          <ErrorState error={history.error} onRetry={() => void history.refetch()} retrying={history.isFetching} title="Could not load the conversation" />
        ) : msgs.length === 0 ? (
          <div className="adm-chat" style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>
            No messages with this parent yet.
          </div>
        ) : (
          <div className="adm-chat" ref={chatRef} role="log" aria-label="Messages">
            {msgs.map((m) => (
              <div key={m.id} className={`adm-msg${m.direction === 'outbound' ? ' adm-msg--out' : ''}`}>
                {m.channel === 'email' && m.subject && <strong className="adm-msg__subject">{m.subject}</strong>}
                {m.body}
                <div className="adm-msg__meta">
                  {m.direction === 'outbound' ? (m.agentId ? 'AI' : 'Staff') : 'Parent'} · {m.channel === 'email' ? 'Email' : m.channel === 'call' ? 'Call' : 'WhatsApp'} · {formatDateTime(m.createdAt)}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <LeadCalls leadId={lead.id} />

      <form
        className="adm-composer"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) send.mutate(text.trim());
        }}
      >
        <Textarea
          id="adm-composer"
          label="Send a WhatsApp message"
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={4000}
          disabled={lead.parent.optedOut}
          hint={lead.parent.optedOut ? 'This parent has opted out of WhatsApp messages.' : undefined}
          placeholder="Type a message to the parent…"
        />
        <div className="adm-composer__row">
          <Button type="submit" variant="secondary" loading={send.isPending} disabled={!text.trim() || lead.parent.optedOut}>
            Send Message
          </Button>
        </div>
      </form>
    </Modal>
  );
}
