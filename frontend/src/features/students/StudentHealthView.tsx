import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileUp, Plus, ScanLine, Search, UserPlus, Users } from 'lucide-react';
import { useAuth } from '../../auth/useAuth';
import { api } from '../../services/api';
import type { HealthStatus, StudentHealthEntry } from '../../types';
import { Button, EmptyState, ErrorState, PageHeader, Skeleton, healthTone, toneColor, useToast } from '../../ui';
import { AddStudentModal } from './AddStudentModal';
import { EnrollModal } from './EnrollModal';
import { ImportStudentsModal } from './ImportStudentsModal';
import { MessageParentModal } from './MessageParentModal';
import { ProfileModal } from './ProfileModal';
import { StudentCard } from './StudentCard';
import { LEVEL_LABEL, type HealthFilter } from './health';
import './students.css';

const FILTERS: { value: HealthFilter; label: string; health?: HealthStatus }[] = [
  { value: 'all', label: 'All' },
  { value: 'GREEN', label: 'Healthy', health: 'GREEN' },
  { value: 'YELLOW', label: 'At-Risk', health: 'YELLOW' },
  { value: 'RED', label: 'Critical', health: 'RED' },
];

export default function StudentHealthView() {
  const { hasPermission } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<HealthFilter>('all');
  const [batchId, setBatchId] = useState('');
  const [search, setSearch] = useState('');
  const [profileFor, setProfileFor] = useState<StudentHealthEntry | null>(null);
  const [messageFor, setMessageFor] = useState<StudentHealthEntry | null>(null);
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const canScan = hasPermission('agents:run');
  const canEnroll = hasPermission('students:manage');
  const canMessage = hasPermission('leads:manage');

  const health = useQuery({
    queryKey: ['students', 'health'],
    queryFn: ({ signal }) => api.dashboard.studentHealth({ signal }),
  });
  const batches = useQuery({
    queryKey: ['students', 'batches'],
    queryFn: ({ signal }) => api.academic.batches({ signal }),
  });

  const scan = useMutation({
    mutationFn: () => api.agents.runAcademicMonitoring(),
    onSuccess: (res) => {
      const r = res.result;
      toast.success(`Scan complete: ${r.totalScanned} students (${r.greenCount} healthy, ${r.yellowCount} at-risk, ${r.redCount} critical)`);
      void qc.invalidateQueries({ queryKey: ['students'] });
    },
    onError: (err) => toast.fromError(err, 'AI scan failed'),
  });

  const batchNamesByStudent = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const b of batches.data ?? []) {
      for (const e of b.enrollments) {
        map.set(e.studentId, [...(map.get(e.studentId) ?? []), b.batchName ?? 'Unnamed']);
      }
    }
    return map;
  }, [batches.data]);

  const scoped = useMemo(() => {
    const batch = (batches.data ?? []).find((b) => b.id === batchId);
    const inBatch = batch ? new Set(batch.enrollments.map((e) => e.studentId)) : null;
    const q = search.trim().toLowerCase();
    return (health.data ?? []).filter((s) => (!inBatch || inBatch.has(s.id)) && (!q || s.fullName.toLowerCase().includes(q)));
  }, [health.data, batches.data, batchId, search]);

  const counts = (h?: HealthStatus) => (h ? scoped.filter((s) => s.health === h).length : scoped.length);
  const visible = filter === 'all' ? scoped : scoped.filter((s) => s.health === filter);

  const messageBlockedReason = canMessage ? null : 'Messaging parents requires the leads:manage permission';

  const actions = (
    <>
      {canScan && (
        <Button variant="secondary" size="sm" icon={<ScanLine size={13} aria-hidden="true" />} loading={scan.isPending} onClick={() => scan.mutate()}>
          Run AI Scan
        </Button>
      )}
      {canEnroll && (
        <>
          <Button variant="secondary" size="sm" icon={<FileUp size={13} aria-hidden="true" />} onClick={() => setImportOpen(true)}>
            Import students
          </Button>
          <Button variant="secondary" size="sm" icon={<UserPlus size={13} aria-hidden="true" />} onClick={() => setAddOpen(true)}>
            Add student
          </Button>
          <Button size="sm" icon={<Plus size={14} aria-hidden="true" />} onClick={() => setEnrollOpen(true)}>
            Enroll
          </Button>
        </>
      )}
    </>
  );

  return (
    <div>
      <PageHeader
        title="Student Health Map"
        subtitle={health.data ? `${health.data.length} active student${health.data.length === 1 ? '' : 's'}` : undefined}
      />

      <div className="sh-toolbar" role="toolbar" aria-label="Student filters">
        {FILTERS.map((f) => (
          <button key={f.value} type="button" className="sh-pill" aria-pressed={filter === f.value} onClick={() => setFilter(f.value)}>
            {f.health && <span className="sh-pill__dot" style={{ background: toneColor(healthTone(f.health)) }} aria-hidden="true" />}
            {f.label}
            <span className="sh-pill__n" aria-label={`${counts(f.health)} students`}>
              {counts(f.health)}
            </span>
          </button>
        ))}
        <div className="sh-sep" />
        <select
          className="sh-select"
          aria-label="Filter by batch"
          value={batchId}
          onChange={(e) => setBatchId(e.target.value)}
          disabled={batches.isPending || batches.isError}
          title={batches.isError ? 'Batches could not be loaded' : undefined}
        >
          <option value="">All batches</option>
          {(batches.data ?? []).map((b) => (
            <option key={b.id} value={b.id}>
              {b.batchName ?? 'Unnamed batch'}
            </option>
          ))}
        </select>
        <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
          <Search size={13} aria-hidden="true" style={{ position: 'absolute', left: 9, color: 'var(--text-dim)' }} />
          <input
            className="sh-search"
            style={{ paddingLeft: 28 }}
            type="search"
            aria-label="Search students by name"
            placeholder="Search by name"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="sh-spacer" />
        {actions}
      </div>

      {health.isPending ? (
        <div className="sh-grid" aria-busy="true" aria-label="Loading students">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} height={280} radius={14} />
          ))}
        </div>
      ) : health.isError ? (
        <ErrorState error={health.error} onRetry={() => void health.refetch()} retrying={health.isFetching} />
      ) : health.data.length === 0 ? (
        <EmptyState icon={<Users size={22} />} title="No active students yet" description="Students appear here once they are admitted." />
      ) : visible.length === 0 ? (
        <EmptyState title="No students match these filters" description={filter === 'all' ? undefined : `No ${LEVEL_LABEL[filter]} students in this view.`} />
      ) : (
        <div className="sh-grid">
          {visible.map((s) => (
            <StudentCard
              key={s.id}
              student={s}
              batchNames={batchNamesByStudent.get(s.id) ?? []}
              onProfile={setProfileFor}
              onMessage={setMessageFor}
              messageBlockedReason={messageBlockedReason}
            />
          ))}
        </div>
      )}

      <ProfileModal student={profileFor} onClose={() => setProfileFor(null)} canViewAttendance={hasPermission('attendance:mark')} />
      <MessageParentModal key={messageFor?.id ?? 'none'} student={messageFor} onClose={() => setMessageFor(null)} />
      {canEnroll && <EnrollModal open={enrollOpen} onClose={() => setEnrollOpen(false)} batches={batches.data ?? []} />}
      {canEnroll && addOpen && <AddStudentModal open onClose={() => setAddOpen(false)} batches={batches.data ?? []} />}
      {canEnroll && importOpen && <ImportStudentsModal onClose={() => setImportOpen(false)} batches={batches.data ?? []} />}
    </div>
  );
}
