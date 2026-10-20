import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../services/api';
import { getErrorMessage, getFieldErrors } from '../../services/http';
import type { BatchRosterStudent } from '../../types';
import { Button, DateInput, Input, Modal, Select, Textarea, useToast } from '../../ui';
import { todayIst } from './dates';
import { teacherKeys } from './hooks';

interface Errors {
  studentId?: string;
  subject?: string;
  markObtained?: string;
  totalMarks?: string;
  testDate?: string;
  teacherComments?: string;
}

interface Props {
  batchId: string;
  students: readonly BatchRosterStudent[];
  onClose: () => void;
}

export function AssessmentFormModal({ batchId, students, onClose }: Props) {
  const toast = useToast();
  const qc = useQueryClient();
  const today = todayIst();
  const [search, setSearch] = useState('');
  const [studentId, setStudentId] = useState('');
  const [subject, setSubject] = useState('');
  const [obtained, setObtained] = useState('');
  const [total, setTotal] = useState('');
  const [testDate, setTestDate] = useState(today);
  const [comments, setComments] = useState('');
  const [errors, setErrors] = useState<Errors>({});

  const matches = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return students.filter((s) => !needle || s.fullName.toLowerCase().includes(needle) || s.id === studentId);
  }, [students, search, studentId]);

  const save = useMutation({
    mutationFn: () =>
      api.academic.createRecord({
        studentId,
        subject: subject.trim(),
        markObtained: Number(obtained),
        totalMarks: Number(total),
        testDate,
        ...(comments.trim() ? { teacherComments: comments.trim() } : {}),
      }),
    onSuccess: (rec) => {
      const name = students.find((s) => s.id === studentId)?.fullName ?? 'student';
      toast.success(`Recorded ${rec.markObtained ?? obtained}/${rec.totalMarks ?? total} in ${rec.subject ?? subject} for ${name}`);
      void qc.invalidateQueries({ queryKey: teacherKeys.students(batchId) });
      void qc.invalidateQueries({ queryKey: teacherKeys.summary(studentId) });
      onClose();
    },
    onError: (err) => {
      const fe = getFieldErrors(err);
      setErrors({ subject: fe.subject, markObtained: fe.markObtained, totalMarks: fe.totalMarks, testDate: fe.testDate, teacherComments: fe.teacherComments });
      toast.error(getErrorMessage(err));
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next: Errors = {};
    const o = Number(obtained);
    const t = Number(total);
    if (!studentId) next.studentId = 'Choose a student';
    if (!subject.trim()) next.subject = 'Subject is required';
    else if (subject.trim().length > 100) next.subject = 'Subject must be 100 characters or fewer';
    if (total === '' || !Number.isFinite(t) || t <= 0) next.totalMarks = 'Total marks must be greater than 0';
    if (obtained === '' || !Number.isFinite(o) || o < 0) next.markObtained = 'Marks obtained must be 0 or more';
    else if (!next.totalMarks && o > t) next.markObtained = 'Marks obtained cannot exceed total marks';
    if (!testDate) next.testDate = 'Pick the assessment date';
    else if (testDate > today) next.testDate = 'Date cannot be in the future';
    if (comments.length > 2000) next.teacherComments = 'Comments must be 2000 characters or fewer';
    setErrors(next);
    if (Object.values(next).some(Boolean)) return;
    save.mutate();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="New assessment"
      subtitle="Record marks for one student"
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="tp-assess-form" loading={save.isPending} disabled={save.isPending}>
            Save assessment
          </Button>
        </>
      }
    >
      <form id="tp-assess-form" className="tp__form" onSubmit={submit} noValidate>
        <Input wrapperClassName="tp__full" label="Search student" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Type a name to filter" />
        <Select
          wrapperClassName="tp__full"
          label="Student"
          required
          value={studentId}
          onChange={(e) => setStudentId(e.target.value)}
          error={errors.studentId}
          placeholder={matches.length === 0 ? 'No student matches' : 'Select a student'}
          options={matches.map((s) => ({ value: s.id, label: s.fullName }))}
        />
        <Input label="Subject" required value={subject} onChange={(e) => setSubject(e.target.value)} error={errors.subject} maxLength={100} />
        <DateInput label="Date" required value={testDate} max={today} onChange={(e) => setTestDate(e.target.value)} error={errors.testDate} />
        <Input label="Marks obtained" type="number" inputMode="decimal" required min={0} step="any" value={obtained} onChange={(e) => setObtained(e.target.value)} error={errors.markObtained} />
        <Input label="Total marks" type="number" inputMode="decimal" required min={0} step="any" value={total} onChange={(e) => setTotal(e.target.value)} error={errors.totalMarks} />
        <Textarea wrapperClassName="tp__full" label="Teacher comments (optional)" rows={3} maxLength={2000} value={comments} onChange={(e) => setComments(e.target.value)} error={errors.teacherComments} />
      </form>
    </Modal>
  );
}
