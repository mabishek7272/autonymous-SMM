import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../services/api';
import { getFieldErrors } from '../../services/http';
import type { BatchDetail } from '../../types';
import { Button, EmptyState, ErrorState, Modal, Select, Skeleton, useToast } from '../../ui';

interface Props {
  open: boolean;
  onClose: () => void;
  batches: BatchDetail[];
}

/** Enrolls an existing student into a batch (POST /academic/batches/:id/enroll). New admissions go through Admissions. */
export function EnrollModal({ open, onClose, batches }: Props) {
  const toast = useToast();
  const qc = useQueryClient();
  const [studentId, setStudentId] = useState('');
  const [batchId, setBatchId] = useState('');

  const students = useQuery({
    queryKey: ['students', 'list'],
    queryFn: ({ signal }) => api.students.list({ signal }),
    enabled: open,
  });

  const enroll = useMutation({
    mutationFn: () => api.academic.enroll(batchId, studentId),
    onSuccess: (res) => {
      toast.success(`${res.student.fullName} enrolled in ${res.batch.batchName ?? 'the batch'}`);
      void qc.invalidateQueries({ queryKey: ['students'] });
      setStudentId('');
      setBatchId('');
      onClose();
    },
    onError: (err) => toast.fromError(err, 'Could not enroll student'),
  });

  const batch = batches.find((b) => b.id === batchId);
  const enrolledIds = new Set(batch?.enrollments.map((e) => e.studentId));
  const candidates = (students.data ?? []).filter((s) => s.status === 'active' && !enrolledIds.has(s.id));
  const fieldErrors = enroll.isError ? getFieldErrors(enroll.error) : {};

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Enroll student"
      subtitle="Add an existing student to a batch"
      width={460}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={enroll.isPending} disabled={!studentId || !batchId} onClick={() => enroll.mutate()}>
            Enroll
          </Button>
        </>
      }
    >
      {students.isPending ? (
        <Skeleton height={100} />
      ) : students.isError ? (
        <ErrorState error={students.error} onRetry={() => void students.refetch()} retrying={students.isFetching} />
      ) : batches.length === 0 ? (
        <EmptyState title="No batches yet" description="Create a batch before enrolling students." />
      ) : (
        <div className="sh-form">
          <Select
            label="Batch"
            value={batchId}
            onChange={(e) => {
              setBatchId(e.target.value);
              setStudentId('');
            }}
            error={fieldErrors.batchId}
            required
          >
            <option value="">Select a batch</option>
            {batches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.course.courseName} · {b.batchName ?? 'Unnamed batch'}
              </option>
            ))}
          </Select>
          <Select
            label="Student"
            value={studentId}
            onChange={(e) => setStudentId(e.target.value)}
            disabled={!batchId}
            error={fieldErrors.studentId}
            hint={batchId && candidates.length === 0 ? 'Every active student is already in this batch.' : undefined}
            required
          >
            <option value="">Select a student</option>
            {candidates.map((s) => (
              <option key={s.id} value={s.id}>
                {s.fullName} (parent: {s.parent.fullName})
              </option>
            ))}
          </Select>
        </div>
      )}
    </Modal>
  );
}
