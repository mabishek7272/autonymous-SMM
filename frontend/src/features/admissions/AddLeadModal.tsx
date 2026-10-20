import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { leads } from '../../services/api';
import { getErrorMessage, getFieldErrors } from '../../services/http';
import { Button, Input, Modal, Select, Textarea, useToast } from '../../ui';
import { LEAD_SOURCES, type LeadSource } from '../../types';
import { BOARD_OPTIONS, GRADE_OPTIONS, SUBJECT_OPTIONS, sourceLabel } from './helpers';

interface AddLeadModalProps {
  open: boolean;
  onClose: () => void;
}

export function AddLeadModal({ open, onClose }: AddLeadModalProps) {
  const qc = useQueryClient();
  const toast = useToast();
  const [parentName, setParentName] = useState('');
  const [whatsappNumber, setWhatsappNumber] = useState('');
  const [grade, setGrade] = useState('');
  const [board, setBoard] = useState('');
  const [subjects, setSubjects] = useState<string[]>([]);
  const [source, setSource] = useState<LeadSource | ''>('');
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      leads.create({
        parentName: parentName.trim(),
        whatsappNumber: whatsappNumber.trim(),
        ...(source ? { source } : {}),
        ...(grade ? { gradeInterested: grade } : {}),
        ...(board ? { boardInterested: board } : {}),
        ...(subjects.length ? { subjectsInterested: subjects } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      }),
    onSuccess: (lead) => {
      toast.success(`Lead added: ${lead.parent.fullName}`);
      void qc.invalidateQueries({ queryKey: ['admissions'] });
      onClose();
    },
    onError: (err) => {
      setErrors(getFieldErrors(err));
      setFormError(getErrorMessage(err));
      toast.fromError(err, 'Could not add lead');
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (parentName.trim().length < 2) next.parentName = 'Enter the parent name (at least 2 characters)';
    if (!whatsappNumber.trim()) next.whatsappNumber = 'Enter a WhatsApp number';
    setErrors(next);
    setFormError(null);
    if (Object.keys(next).length === 0) create.mutate();
  };

  const toggleSubject = (s: string) => setSubjects((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add Lead"
      subtitle="Creates the parent contact and the lead together"
      width={560}
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="adm-add-lead" loading={create.isPending}>
            Add Lead
          </Button>
        </>
      }
    >
      <form id="adm-add-lead" onSubmit={submit} noValidate className="adm-form-grid">
        <Input label="Parent name" required value={parentName} onChange={(e) => setParentName(e.target.value)} error={errors.parentName} autoComplete="off" />
        <Input
          label="WhatsApp number"
          required
          type="tel"
          value={whatsappNumber}
          onChange={(e) => setWhatsappNumber(e.target.value)}
          error={errors.whatsappNumber}
          hint="With country code, e.g. +91…"
          autoComplete="off"
        />
        <Select label="Class" value={grade} onChange={(e) => setGrade(e.target.value)} placeholder="Not specified" options={GRADE_OPTIONS.map((g) => ({ value: g, label: g }))} error={errors.gradeInterested} />
        <Select label="Board" value={board} onChange={(e) => setBoard(e.target.value)} placeholder="Not specified" options={BOARD_OPTIONS.map((b) => ({ value: b, label: b }))} error={errors.boardInterested} />
        <fieldset className="adm-fieldset" style={{ gridColumn: '1 / -1' }}>
          <legend>Subjects</legend>
          <div className="adm-chips">
            {SUBJECT_OPTIONS.map((s) => (
              <button key={s} type="button" className="adm-chip" aria-pressed={subjects.includes(s)} onClick={() => toggleSubject(s)}>
                {s}
              </button>
            ))}
          </div>
        </fieldset>
        <Select
          label="Source"
          value={source}
          onChange={(e) => setSource(e.target.value as LeadSource | '')}
          placeholder="Not specified"
          options={LEAD_SOURCES.map((s) => ({ value: s, label: sourceLabel(s) }))}
         
        />
        <Textarea label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} error={errors.notes} wrapperClassName="adm-span-all" maxLength={5000} />
        {formError && Object.keys(errors).length === 0 && (
          <div className="adm-form-error" role="alert" style={{ gridColumn: '1 / -1' }}>
            {formError}
          </div>
        )}
      </form>
    </Modal>
  );
}
