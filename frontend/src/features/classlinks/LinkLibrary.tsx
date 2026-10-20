import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, FileUp, Link2, Pencil, Plus, Trash2 } from 'lucide-react';
import { api } from '../../services/api';
import { getErrorMessage } from '../../services/http';
import type { ClassLinkWithUsage } from '../../types';
import { Badge, Button, Card, EmptyState, ErrorState, SkeletonList, Table, Toggle, useConfirm, useToast, type TableColumn } from '../../ui';
import { classLinkKeys, useClassLinks } from './hooks';
import { ImportModal } from './ImportModal';
import { LinkFormModal } from './LinkFormModal';

function describe(l: ClassLinkWithUsage): string {
  return [l.grade ? `Class ${l.grade}` : null, l.board, l.subject].filter(Boolean).join(' · ');
}

export function LinkLibrary() {
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const query = useClassLinks();
  const [editing, setEditing] = useState<ClassLinkWithUsage | 'new' | null>(null);
  const [importing, setImporting] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: classLinkKeys.list });
    void qc.invalidateQueries({ queryKey: classLinkKeys.batches });
  };

  const toggle = useMutation({
    mutationFn: ({ l, isActive }: { l: ClassLinkWithUsage; isActive: boolean }) => api.classLinks.update(l.id, { isActive }),
    onMutate: ({ l }) => setPendingId(l.id),
    onSuccess: (saved) => {
      toast.success(`"${saved.name}" is now ${saved.isActive ? 'active' : 'inactive'}`);
      refresh();
    },
    onError: (err) => toast.error(getErrorMessage(err)),
    onSettled: () => setPendingId(null),
  });

  const remove = useMutation({
    mutationFn: (l: ClassLinkWithUsage) => api.classLinks.remove(l.id),
    onSuccess: (_r, l) => {
      toast.success(`Deleted "${l.name}"`);
      refresh();
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });

  const onDelete = async (l: ClassLinkWithUsage) => {
    const ok = await confirm({ title: `Delete "${l.name}"?`, message: 'This removes the link from the library. It cannot be undone.', confirmLabel: 'Delete', tone: 'danger' });
    if (ok) remove.mutate(l);
  };

  if (query.isPending) return <SkeletonList rows={5} />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} />;

  const links = query.data.data;

  const columns: TableColumn<ClassLinkWithUsage>[] = [
    {
      key: 'name',
      header: 'Class group',
      sortValue: (l) => l.name,
      render: (l) => (
        <div>
          <div className="cl__name">{l.name}</div>
          {describe(l) && <div className="cl__muted">{describe(l)}</div>}
        </div>
      ),
    },
    {
      key: 'url',
      header: 'Meeting link',
      render: (l) => (
        <a className="cl__url" href={l.meetingUrl} target="_blank" rel="noopener noreferrer" title={l.meetingUrl}>
          <span>{l.meetingUrl.replace(/^https:\/\//, '')}</span>
          <ExternalLink size={12} aria-hidden="true" />
        </a>
      ),
    },
    {
      key: 'used',
      header: 'Batches',
      align: 'right',
      sortValue: (l) => l._count.batches,
      render: (l) => (l._count.batches ? <Badge tone="primary">{l._count.batches}</Badge> : <span className="cl__muted">Unused</span>),
    },
    {
      key: 'active',
      header: 'Active',
      render: (l) => (
        <Toggle
          checked={l.isActive}
          label={`${l.name} active`}
          disabled={pendingId === l.id}
          onChange={(isActive) => toggle.mutate({ l, isActive })}
        />
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (l) => (
        <div className="cl__actions">
          <Button variant="ghost" size="sm" iconOnly aria-label={`Edit ${l.name}`} icon={<Pencil size={14} />} onClick={() => setEditing(l)} />
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label={`Delete ${l.name}`}
            icon={<Trash2 size={14} />}
            disabled={l._count.batches > 0 || remove.isPending}
            title={l._count.batches > 0 ? 'Unassign it from its batches first, or deactivate it' : undefined}
            onClick={() => void onDelete(l)}
          />
        </div>
      ),
    },
  ];

  return (
    <Card>
      <div className="cl__toolbar">
        <div>
          <h2 className="cl__h2">Link library</h2>
          <p className="cl__hint">Your standing Teams links, one per class group. Assign each to a batch and it is reused every day.</p>
        </div>
        <div className="cl__toolbar-actions">
          <Button variant="secondary" icon={<FileUp size={14} />} onClick={() => setImporting(true)}>
            Import links
          </Button>
          <Button icon={<Plus size={14} />} onClick={() => setEditing('new')}>
            Add link
          </Button>
        </div>
      </div>
      <Table
        caption="Class link library"
        columns={columns}
        rows={links}
        rowKey={(l) => l.id}
        initialSort={{ key: 'name', dir: 'asc' }}
        empty={
          <EmptyState
            icon={<Link2 size={32} />}
            title="No class links yet"
            description="Add a link, or paste your list of links from a spreadsheet to import them all at once."
            action={<Button onClick={() => setImporting(true)}>Import links</Button>}
          />
        }
      />
      {editing && <LinkFormModal link={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {importing && <ImportModal onClose={() => setImporting(false)} />}
    </Card>
  );
}
