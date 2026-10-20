import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus, Sparkles } from 'lucide-react';
import { api } from '../../services/api';
import type { AcademicRecord, BatchDetail } from '../../types';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, SkeletonList } from '../../ui';
import { AssessmentFormModal } from './AssessmentForm';
import { dateOnly, formatYmd } from './dates';
import { batchLabel } from './helpers';
import { teacherKeys } from './hooks';

const FEED_LIMIT = 30;

interface FeedItem {
  record: AcademicRecord;
  studentName: string;
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, '');
}

function SubjectAnalysis({ studentId, subject }: { studentId: string; subject: string | null }) {
  const q = useQuery({
    queryKey: teacherKeys.summary(studentId),
    queryFn: ({ signal }) => api.academic.summary(studentId, { signal }),
  });
  const entry = subject ? q.data?.subjectSummary?.find((s) => s.subject === subject) : undefined;
  if (!entry) return null;
  return (
    <div className="tp__analysis">
      <Sparkles size={13} aria-hidden="true" style={{ marginTop: 2, flex: 'none' }} />
      <span style={{ flex: 1 }}>
        {entry.subject} average {entry.averagePercentage}% across {entry.assessments} {entry.assessments === 1 ? 'assessment' : 'assessments'}.
      </span>
      {entry.flag === 'WEAK' ? <Badge tone="danger">Weak subject</Badge> : <Badge tone="success">On track</Badge>}
    </div>
  );
}

export function AssessmentsTab({ batch, canCreate }: { batch: BatchDetail; canCreate: boolean }) {
  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: teacherKeys.students(batch.id),
    queryFn: ({ signal }) => api.academic.batchStudents(batch.id, { signal }),
  });

  const feed = useMemo<FeedItem[]>(() => {
    const items: FeedItem[] = (q.data ?? []).flatMap((s) => s.academicRecords.map((record) => ({ record, studentName: s.fullName })));
    const when = (r: AcademicRecord) => r.testDate ?? r.createdAt;
    return items.sort((a, b) => when(b.record).localeCompare(when(a.record))).slice(0, FEED_LIMIT);
  }, [q.data]);

  return (
    <div className="tp__stack">
      <Card flush>
        <CardHeader
          title={`Assessments · ${batchLabel(batch)}`}
          subtitle="Most recent marks recorded for this batch"
          actions={
            canCreate && (
              <Button size="sm" icon={<Plus size={14} aria-hidden="true" />} disabled={!q.data || q.data.length === 0} onClick={() => setOpen(true)}>
                New assessment
              </Button>
            )
          }
        />
        {q.isPending ? (
          <div style={{ padding: 18 }}>
            <SkeletonList rows={3} rowHeight={90} />
          </div>
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
        ) : q.data.length === 0 ? (
          <EmptyState title="No students enrolled" description="Marks can be recorded once students are enrolled in this batch." />
        ) : feed.length === 0 ? (
          <EmptyState title="No assessments recorded yet" description={canCreate ? 'Use New assessment to record the first marks.' : undefined} />
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} aria-label="Recent assessments">
            {feed.map(({ record: r, studentName }) => {
              const obtained = r.markObtained === null ? null : Number(r.markObtained);
              const totalMarks = r.totalMarks === null ? null : Number(r.totalMarks);
              const pct = obtained !== null && totalMarks ? Math.round((obtained / totalMarks) * 100) : null;
              return (
                <li key={r.id} className="tp__assess" style={{ borderTop: '1px solid var(--border-faint)' }}>
                  <div className="tp__assess-main">
                    <div className="tp__assess-head">
                      <span className="tp__assess-name">{studentName}</span>
                      {r.subject && <Badge>{r.subject}</Badge>}
                      <span className="tp__assess-date">{formatYmd(dateOnly(r.testDate ?? r.createdAt))}</span>
                    </div>
                    {r.teacherComments && <div className="tp__assess-note">“{r.teacherComments}”</div>}
                    <SubjectAnalysis studentId={r.studentId} subject={r.subject} />
                  </div>
                  <div className="tp__score">
                    <strong>
                      {obtained === null ? '—' : fmt(obtained)}
                      <span>/{totalMarks === null ? '—' : fmt(totalMarks)}</span>
                    </strong>
                    {pct !== null && <small>{pct}%</small>}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      {open && q.data && <AssessmentFormModal batchId={batch.id} students={q.data} onClose={() => setOpen(false)} />}
    </div>
  );
}
