import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { students } from '../../services/api';
import { getErrorMessage, getFieldErrors } from '../../services/http';
import type { BatchDetail } from '../../types';
import { Button, Input, Modal, useToast } from '../../ui';

interface Props {
  open: boolean;
  onClose: () => void;
  batches: BatchDetail[];
}

const BOARDS = ['CBSE', 'Matric', 'State', 'ICSE'];

/** Registers one student with the parent's contact details and the batches (class + subject) they study. */
export function AddStudentModal({ open, onClose, batches }: Props) {
  const toast = useToast();
  const qc = useQueryClient();
  const [studentName, setStudentName] = useState('');
  const [parentName, setParentName] = useState('');
  const [parentPhone, setParentPhone] = useState('');
  const [parentEmail, setParentEmail] = useState('');
  const [grade, setGrade] = useState('');
  const [board, setBoard] = useState('');
  const [dob, setDob] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});

  const save = useMutation({
    mutationFn: () =>
      students.register({
        studentName: studentName.trim(),
        parentPhone: parentPhone.trim(),
        ...(parentName.trim() ? { parentName: parentName.trim() } : {}),
        ...(parentEmail.trim() ? { parentEmail: parentEmail.trim() } : {}),
        ...(grade.trim() ? { grade: grade.trim() } : {}),
        ...(board.trim() ? { board: board.trim() } : {}),
        ...(dob ? { dateOfBirth: dob } : {}),
        ...(picked.length ? { batches: picked.join('; ') } : {}),
      }),
    onSuccess: (res) => {
      toast.success(res.created ? `${res.student.fullName} registered` : `${res.student.fullName} already existed; ${res.enrollmentsAdded} batch(es) added`);
      void qc.invalidateQueries({ queryKey: ['students'] });
      void qc.invalidateQueries({ queryKey: ['teacher', 'batches'] });
      onClose();
    },
    onError: (err) => {
      setErrors(getFieldErrors(err));
      toast.error(getErrorMessage(err));
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next: Record<string, string | undefined> = {};
    if (studentName.trim().length < 2) next.studentName = 'Enter the student’s name';
    if (!/\d{6,}/.test(parentPhone.replace(/\D/g, ''))) next.parentPhone = 'Enter the parent’s WhatsApp number';
    if (parentEmail && !/^\S+@\S+\.\S+$/.test(parentEmail)) next.parentEmail = 'Enter a valid email or leave it empty';
    setErrors(next);
    if (Object.values(next).some(Boolean)) return;
    save.mutate();
  };

  const toggle = (name: string) => setPicked((p) => (p.includes(name) ? p.filter((x) => x !== name) : [...p, name]));
  const named = batches.filter((b) => b.batchName);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add student"
      subtitle="Register a student with the parent's contact and the batches they study"
      width={620}
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="add-student-form" loading={save.isPending} disabled={save.isPending}>
            Add student
          </Button>
        </>
      }
    >
      <form id="add-student-form" className="sh-form" onSubmit={submit} noValidate>
        <Input label="Student name" required value={studentName} onChange={(e) => setStudentName(e.target.value)} error={errors.studentName} />
        <Input label="Date of birth (optional)" type="date" value={dob} onChange={(e) => setDob(e.target.value)} error={errors.dateOfBirth} />
        <Input label="Parent name" value={parentName} onChange={(e) => setParentName(e.target.value)} error={errors.parentName} hint="Needed for a new parent; ignored if the number is already registered" />
        <Input label="Parent WhatsApp number" required inputMode="tel" value={parentPhone} onChange={(e) => setParentPhone(e.target.value)} error={errors.parentPhone} placeholder="9876543210" />
        <Input label="Parent email (optional)" type="email" value={parentEmail} onChange={(e) => setParentEmail(e.target.value)} error={errors.parentEmail} />
        <div className="sh-form__row">
          <Input label="Class" value={grade} onChange={(e) => setGrade(e.target.value)} error={errors.grade} placeholder="12" />
          <Input label="Board" value={board} onChange={(e) => setBoard(e.target.value)} error={errors.board} list="sh-boards" placeholder="CBSE" />
          <datalist id="sh-boards">
            {BOARDS.map((b) => (
              <option key={b} value={b} />
            ))}
          </datalist>
        </div>
        <fieldset className="sh-form__batches">
          <legend>Batches (class &amp; subject)</legend>
          {named.length === 0 ? (
            <p className="sh-form__hint">No batches exist yet. Import the timetable first (Class Links → Import timetable), then add students to batches.</p>
          ) : (
            <div className="sh-form__chips">
              {named.map((b) => (
                <label key={b.id} className={`sh-chip${picked.includes(b.batchName!) ? ' sh-chip--on' : ''}`}>
                  <input type="checkbox" checked={picked.includes(b.batchName!)} onChange={() => toggle(b.batchName!)} />
                  {b.batchName}
                </label>
              ))}
            </div>
          )}
        </fieldset>
      </form>
    </Modal>
  );
}
