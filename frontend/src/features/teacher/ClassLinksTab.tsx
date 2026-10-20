import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCheck, ExternalLink, Pencil, Plus, Send, Trash2 } from 'lucide-react';
import { api } from '../../services/api';
import { getErrorMessage } from '../../services/http';
import type { BatchDetail, ClassSessionWithBatch } from '../../types';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, SkeletonList, useConfirm, useToast } from '../../ui';
import { formatDateTimeIst, formatTimeIst, formatYmd, istDateOf, todayIst } from './dates';
import { batchLabel } from './helpers';
import { teacherKeys } from './hooks';
import { SessionFormModal } from './SessionForm';

export function ClassLinksTab({ batch }: { batch: BatchDetail }) {
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [form, setForm] = useState<{ session: ClassSessionWithBatch | null } | null>(null);
  const [showEarlier, setShowEarlier] = useState(false);

  const q = useQuery({
    queryKey: teacherKeys.sessions(batch.id),
    queryFn: ({ signal }) => api.sessions.list({ batchId: batch.id }, { signal }),
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: teacherKeys.sessions(batch.id) });
    void qc.invalidateQueries({ queryKey: teacherKeys.sessionsToday });
  };

  const announce = useMutation({
    mutationFn: (id: string) => api.sessions.announce(id),
    onSuccess: (res) => {
      const skipped = res.parentsSkippedOptedOut > 0 ? `, ${res.parentsSkippedOptedOut} opted out` : '';
      toast.success(`Sent to ${res.parentsMessaged} ${res.parentsMessaged === 1 ? 'parent' : 'parents'}${skipped}`);
      refresh();
    },
    onError: (err) => {
      toast.error(getErrorMessage(err));
      refresh();
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.sessions.remove(id),
    onSuccess: () => {
      toast.success('Class link deleted');
      refresh();
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  const onAnnounce = async (s: ClassSessionWithBatch) => {
    const ok = await confirm({
      title: 'Send class link to parents?',
      message: `This messages the parents of ${batchLabel(batch)} on WhatsApp now with the link for ${s.topic ?? 'this class'} (${formatDateTimeIst(s.startsAt)}).`,
      confirmLabel: 'Send now',
    });
    if (ok) announce.mutate(s.id);
  };

  const onDelete = async (s: ClassSessionWithBatch) => {
    const ok = await confirm({
      title: 'Delete this class link?',
      message: `${s.topic ?? 'Class'} on ${formatDateTimeIst(s.startsAt)} will be removed.`,
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (ok) remove.mutate(s.id);
  };

  const today = todayIst();
  const all = q.data ?? [];
  const todays = all.filter((s) => istDateOf(s.startsAt) === today);
  const upcoming = all.filter((s) => istDateOf(s.startsAt) > today);
  const earlier = all.filter((s) => istDateOf(s.startsAt) < today).reverse();

  const renderSession = (s: ClassSessionWithBatch) => (
    <li key={s.id} className="tp__session">
      <div className="tp__time">
        {formatTimeIst(s.startsAt)}
        <small>{formatYmd(istDateOf(s.startsAt))}</small>
      </div>
      <div style={{ minWidth: 0 }}>
        <div className="tp__session-title">
          {s.topic ?? 'Class'}
          {s.announcedAt ? (
            <Badge tone="success" icon={<CheckCheck size={11} aria-hidden="true" />}>
              Sent to parents {formatDateTimeIst(s.announcedAt)}
            </Badge>
          ) : (
            <Badge tone="warning">Not sent yet</Badge>
          )}
        </div>
        <div className="tp__session-meta">
          {s.durationMinutes} min ·{' '}
          <a href={s.meetingUrl} target="_blank" rel="noopener noreferrer">
            {s.meetingUrl} <ExternalLink size={11} aria-hidden="true" />
          </a>
        </div>
        {s.notes && <div className="tp__session-meta">{s.notes}</div>}
      </div>
      <div className="tp__actions">
        {!s.announcedAt && (
          <Button
            size="sm"
            variant="warm"
            icon={<Send size={13} aria-hidden="true" />}
            loading={announce.isPending && announce.variables === s.id}
            disabled={announce.isPending}
            aria-label={`Send ${s.topic ?? 'class'} link to parents now`}
            onClick={() => void onAnnounce(s)}
          >
            Send to parents now
          </Button>
        )}
        <Button size="sm" variant="secondary" iconOnly aria-label={`Edit ${s.topic ?? 'class'} link`} onClick={() => setForm({ session: s })}>
          <Pencil size={13} aria-hidden="true" />
        </Button>
        <Button
          size="sm"
          variant="danger"
          iconOnly
          aria-label={`Delete ${s.topic ?? 'class'} link`}
          disabled={remove.isPending}
          onClick={() => void onDelete(s)}
        >
          <Trash2 size={13} aria-hidden="true" />
        </Button>
      </div>
    </li>
  );

  const section = (title: string, list: ClassSessionWithBatch[]) =>
    list.length > 0 && (
      <>
        <h3 className="tp__section-title">{title}</h3>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} aria-label={title}>
          {list.map(renderSession)}
        </ul>
      </>
    );

  return (
    <Card flush>
      <CardHeader
        title={`Class links · ${batchLabel(batch)}`}
        subtitle="Daily meeting links, sent to parents on WhatsApp"
        actions={
          <Button size="sm" icon={<Plus size={14} aria-hidden="true" />} onClick={() => setForm({ session: null })}>
            Add class link
          </Button>
        }
      />
      {q.isPending ? (
        <div style={{ padding: 18 }}>
          <SkeletonList rows={3} />
        </div>
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
      ) : all.length === 0 ? (
        <EmptyState title="No class links yet" description="Add a link for today's class and send it to parents." />
      ) : (
        <>
          {todays.length === 0 && <p className="tp__section-title" style={{ textTransform: 'none' }}>No class link for today yet.</p>}
          {section('Today', todays)}
          {section('Upcoming', upcoming)}
          {earlier.length > 0 && (
            <>
              <div style={{ padding: '10px 18px' }}>
                <Button variant="ghost" size="sm" aria-expanded={showEarlier} onClick={() => setShowEarlier((v) => !v)}>
                  {showEarlier ? 'Hide earlier sessions' : `Show earlier sessions (${earlier.length})`}
                </Button>
              </div>
              {showEarlier && section('Earlier', earlier)}
            </>
          )}
        </>
      )}
      {form && <SessionFormModal batch={batch} session={form.session} onClose={() => setForm(null)} />}
    </Card>
  );
}
