import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../services/api';
import type { StudentHealthEntry } from '../../types';
import { Badge, ErrorState, Modal, Skeleton } from '../../ui';
import { LEVEL_LABEL, formatDate, toNumber, ymd } from './health';

interface Props {
  student: StudentHealthEntry | null;
  onClose: () => void;
  canViewAttendance: boolean;
}

const LEVEL_BADGE = { GREEN: 'success', YELLOW: 'warning', RED: 'danger', UNKNOWN: 'neutral' } as const;

export function ProfileModal({ student, onClose, canViewAttendance }: Props) {
  const id = student?.id;
  const [range] = useState(() => {
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - 29);
    return { from: ymd(from), to: ymd(to) };
  });

  const detail = useQuery({
    queryKey: ['students', 'detail', id],
    queryFn: ({ signal }) => api.students.get(id as string, { signal }),
    enabled: Boolean(id),
  });
  const history = useQuery({
    queryKey: ['students', 'attendance', id, range.from, range.to],
    queryFn: ({ signal }) => api.attendance.studentHistory(id as string, range.from, range.to, { signal }),
    enabled: Boolean(id) && canViewAttendance,
  });

  return (
    <Modal
      open={student !== null}
      onClose={onClose}
      title={student?.fullName ?? 'Student'}
      subtitle={student ? `Parent: ${student.parent.fullName}` : undefined}
      headerExtra={student && <Badge tone={LEVEL_BADGE[student.health]} uppercase>{LEVEL_LABEL[student.health]}</Badge>}
      width={640}
    >
      {detail.isPending ? (
        <Skeleton height={160} />
      ) : detail.isError ? (
        <ErrorState error={detail.error} onRetry={() => void detail.refetch()} retrying={detail.isFetching} />
      ) : (
        <div className="sh-profile">
          <section aria-label="Enrollments">
            <h3>Enrollments</h3>
            {detail.data.enrollments.length === 0 ? (
              <p className="sh-muted">Not enrolled in any batch.</p>
            ) : (
              <ul className="sh-list">
                {detail.data.enrollments.map((e) => (
                  <li key={e.id}>
                    <span>
                      {e.batch.course.courseName} · {e.batch.batchName ?? 'Unnamed batch'}
                    </span>
                    <span className="sh-muted">since {formatDate(e.enrollmentDate)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-label="Academic records">
            <h3>Academic records</h3>
            {detail.data.academicRecords.length === 0 ? (
              <p className="sh-muted">No assessments recorded yet.</p>
            ) : (
              <ul className="sh-list">
                {detail.data.academicRecords.map((r) => (
                  <li key={r.id}>
                    <span>
                      {r.subject ?? 'Test'}
                      {r.testDate ? ` · ${formatDate(r.testDate)}` : ''}
                    </span>
                    <span>
                      {toNumber(r.markObtained) ?? '—'} / {toNumber(r.totalMarks) ?? '—'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {canViewAttendance && (
            <section aria-label="Attendance history">
              <h3>Attendance, last 30 days</h3>
              {history.isPending ? (
                <Skeleton height={60} />
              ) : history.isError ? (
                <ErrorState error={history.error} onRetry={() => void history.refetch()} retrying={history.isFetching} />
              ) : history.data.history.length === 0 ? (
                <p className="sh-muted">No attendance marked in this period.</p>
              ) : (
                <>
                  <p className="sh-muted">
                    {history.data.presentDays} of {history.data.markedDays} marked days present
                    {history.data.percentage !== null ? ` (${history.data.percentage}%)` : ''}
                  </p>
                  <ul className="sh-list">
                    {history.data.history.map((h) => (
                      <li key={h.id}>
                        <span>
                          {formatDate(h.date)} · {h.batch.batchName ?? 'Batch'}
                        </span>
                        <Badge tone={h.status === 'absent' ? 'danger' : h.status === 'late' ? 'warning' : 'success'}>{h.status}</Badge>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          )}
        </div>
      )}
    </Modal>
  );
}
