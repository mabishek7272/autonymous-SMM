import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileUp, Pencil, Plus, Users } from 'lucide-react';
import { useAuth } from '../../auth/useAuth';
import { RequirePermission } from '../../auth/RequirePermission';
import { api } from '../../services/api';
import { ROLE_LABELS, type Role } from '../../types/permissions';
import type { User } from '../../types';
import { Avatar, Badge, Button, Card, EmptyState, ErrorState, PageHeader, SkeletonList, Table, Toggle, useConfirm, useToast, type BadgeTone, type TableColumn } from '../../ui';
import { getErrorMessage } from '../../services/http';
import { ImportTeachersModal } from './ImportTeachersModal';
import { RolesLegend } from './RolesLegend';
import { UserFormModal } from './UserFormModal';
import './admin.css';

const ROLE_TONE: Record<Role, BadgeTone> = { superadmin: 'warm', admin: 'primary', manager: 'info', teacher: 'neutral' };

export default function UsersView() {
  return (
    <RequirePermission permission="users:manage" fallback={<EmptyState title="No access" description="You do not have permission to manage users." />}>
      <UsersContent />
    </RequirePermission>
  );
}

function UsersContent() {
  const { user: me } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [importingTeachers, setImportingTeachers] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const query = useQuery({ queryKey: ['users'], queryFn: ({ signal }) => api.users.list({ signal }) });

  const toggle = useMutation({
    mutationFn: ({ u, isActive }: { u: User; isActive: boolean }) => api.users.update(u.id, { isActive }),
    onMutate: ({ u }) => setPendingId(u.id),
    onSuccess: (saved) => {
      toast.success(`${saved.fullName} is now ${saved.isActive ? 'active' : 'deactivated'}`);
      void qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (err) => toast.error(getErrorMessage(err)),
    onSettled: () => setPendingId(null),
  });

  const onToggle = async (u: User, isActive: boolean) => {
    if (!isActive) {
      const ok = await confirm({
        title: `Deactivate ${u.fullName}?`,
        message: 'They will no longer be able to sign in. You can reactivate the account later.',
        confirmLabel: 'Deactivate',
        tone: 'danger',
      });
      if (!ok) return;
    }
    toggle.mutate({ u, isActive });
  };

  const canTouch = (u: User) => me?.role === 'superadmin' || u.role !== 'superadmin';

  const columns: TableColumn<User>[] = [
    {
      key: 'name',
      header: 'Name',
      sortValue: (u) => u.fullName,
      render: (u) => (
        <div className="adm-user">
          <Avatar name={u.fullName} />
          <div>
            <div className="adm-user__name">
              {u.fullName}
              {me?.id === u.id && <span className="adm-muted"> (you)</span>}
            </div>
            <div className="adm-muted">{u.email}</div>
          </div>
        </div>
      ),
    },
    { key: 'role', header: 'Role', sortValue: (u) => u.role, render: (u) => <Badge tone={ROLE_TONE[u.role]}>{ROLE_LABELS[u.role]}</Badge> },
    { key: 'phone', header: 'Phone', render: (u) => (u.phone ? <span className="adm-mono">{u.phone}</span> : <span className="adm-muted">Not set</span>) },
    {
      key: 'active',
      header: 'Active',
      sortValue: (u) => (u.isActive ? 1 : 0),
      render: (u) => (
        <Toggle
          hideLabel
          label={`${u.fullName} active`}
          checked={u.isActive}
          disabled={pendingId === u.id || me?.id === u.id || !canTouch(u)}
          onChange={(v) => void onToggle(u, v)}
        />
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      align: 'right',
      render: (u) => (
        <Button variant="ghost" size="sm" icon={<Pencil size={13} aria-hidden="true" />} disabled={!canTouch(u)} onClick={() => setEditing(u)} aria-label={`Edit ${u.fullName}`}>
          Edit
        </Button>
      ),
    },
  ];

  const rows = query.data?.data ?? [];

  return (
    <div className="adm-stack">
      <PageHeader
        title="Users"
        subtitle="Staff accounts and the role that decides what each person can access."
        actions={
          <>
            <Button variant="secondary" icon={<FileUp size={14} aria-hidden="true" />} onClick={() => setImportingTeachers(true)}>
              Import teachers
            </Button>
            <Button icon={<Plus size={14} aria-hidden="true" />} onClick={() => setAdding(true)}>
              Add user
            </Button>
          </>
        }
      />
      <Card flush>
        {query.isPending ? (
          <div style={{ padding: 16 }}>
            <SkeletonList rows={4} label="Loading users" />
          </div>
        ) : query.isError ? (
          <ErrorState error={query.error} title="Could not load users" onRetry={() => void query.refetch()} retrying={query.isFetching} />
        ) : (
          <Table
            caption="Users"
            columns={columns}
            rows={rows}
            rowKey={(u) => u.id}
            empty={<EmptyState icon={<Users size={22} aria-hidden="true" />} title="No users yet" description="Add the first staff account." action={{ label: 'Add user', onClick: () => setAdding(true) }} />}
          />
        )}
      </Card>
      <RolesLegend />
      {adding && <UserFormModal open onClose={() => setAdding(false)} />}
      {importingTeachers && <ImportTeachersModal onClose={() => setImportingTeachers(false)} />}
      {editing && <UserFormModal key={editing.id} open user={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
