import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { academic, students } from '../../services/api';
import { getErrorMessage, getFieldErrors } from '../../services/http';
import { Button, DateInput, EmptyState, ErrorState, Input, Modal, Select, Spinner, useToast } from '../../ui';
import { isAdmissible } from '../../types/lead-stages';
import type { LeadWithParent, OnboardResult } from '../../types';
import { PAYMENT_MODES, academicLine, leadName } from './helpers';

interface EnrollWizardProps {
  leads: LeadWithParent[];
  initialLeadId: string | null;
  onClose: () => void;
}

const STEPS = ['Lead', 'Batch & payment', 'Confirm'] as const;

const WELCOME_TEXT: Record<OnboardResult['welcomeMessage'], string> = {
  queued: 'Welcome message queued on WhatsApp.',
  skipped_no_number: 'No welcome message: the parent has no WhatsApp number.',
  skipped_opted_out: 'No welcome message: the parent opted out of WhatsApp.',
  failed: 'The welcome message could not be queued.',
};

export function EnrollWizard({ leads, initialLeadId, onClose }: EnrollWizardProps) {
  const qc = useQueryClient();
  const toast = useToast();
  const eligible = leads.filter((l) => isAdmissible(l.status) && l.status !== 'converted');
  const [step, setStep] = useState<0 | 1 | 2>(initialLeadId ? 1 : 0);
  const [leadId, setLeadId] = useState<string | null>(initialLeadId);
  const [studentName, setStudentName] = useState('');
  const [dob, setDob] = useState('');
  const [batchId, setBatchId] = useState('');
  const [reference, setReference] = useState('');
  const [amount, setAmount] = useState('');
  const [mode, setMode] = useState<string>(PAYMENT_MODES[0]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);

  const lead = leads.find((l) => l.id === leadId) ?? null;
  const batches = useQuery({ queryKey: ['admissions', 'batches'], queryFn: ({ signal }) => academic.batches({ signal }) });
  const batch = batches.data?.find((b) => b.id === batchId) ?? null;
  const batchLabel = (b: { batchName: string | null; course: { courseName: string } }) => `${b.batchName ?? 'Batch'} · ${b.course.courseName}`;

  const amountNum = Number(amount);
  const validate = (): Record<string, string> => {
    const e: Record<string, string> = {};
    if (studentName.trim().length < 2) e.studentName = 'Enter the student name (at least 2 characters)';
    if (reference.trim().length < 3) e.paymentReference = 'Enter the payment reference (at least 3 characters)';
    if (!(amountNum > 0)) e.amountPaid = 'Enter the amount paid';
    return e;
  };

  const enroll = useMutation({
    mutationFn: () =>
      students.onboardLead({
        leadId: leadId as string,
        studentName: studentName.trim(),
        paymentReference: reference.trim(),
        amountPaid: amountNum,
        paymentMode: mode,
        ...(batchId ? { batchId } : {}),
        ...(dob ? { dateOfBirth: dob } : {}),
      }),
    onSuccess: (res) => {
      toast.success(`${res.student.fullName} admitted. ${WELCOME_TEXT[res.welcomeMessage]}`);
      void qc.invalidateQueries({ queryKey: ['admissions'] });
      onClose();
    },
    onError: (err) => {
      setErrors(getFieldErrors(err));
      setServerError(getErrorMessage(err));
      toast.fromError(err, 'Could not enroll student');
      // Payment reference conflicts are fixed on the details step.
      setStep(1);
    },
  });

  const next = () => {
    if (step === 0 && leadId) setStep(1);
    else if (step === 1) {
      const e = validate();
      setErrors(e);
      setServerError(null);
      if (Object.keys(e).length === 0) setStep(2);
    }
  };

  const footer = (
    <>
      <Button variant="secondary" onClick={onClose} disabled={enroll.isPending}>
        Cancel
      </Button>
      <span style={{ flex: 1 }} />
      {step > 0 && (
        <Button variant="secondary" onClick={() => setStep((step - 1) as 0 | 1)} disabled={enroll.isPending}>
          Back
        </Button>
      )}
      {step < 2 ? (
        <Button onClick={next} disabled={step === 0 && !leadId}>
          Next
        </Button>
      ) : (
        <Button loading={enroll.isPending} onClick={() => enroll.mutate()}>
          Confirm enrollment
        </Button>
      )}
    </>
  );

  return (
    <Modal open onClose={onClose} title="Enroll Student" width={560} closeOnBackdrop={false} footer={footer}>
      <ol className="adm-steps" aria-label="Enrollment steps" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {STEPS.map((label, i) => (
          <li key={label} className={`adm-step${i === step ? ' adm-step--active' : ''}${i < step ? ' adm-step--done' : ''}`} aria-current={i === step ? 'step' : undefined}>
            <span className="adm-step__n">{i < step ? '✓' : i + 1}</span>
            <span className="adm-step__label">{label}</span>
            <span className="adm-step__line" />
          </li>
        ))}
      </ol>

      {step === 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Choose a lead who is ready for admission (Interested, Demo Booked or Follow-up)</span>
          {eligible.length === 0 ? (
            <EmptyState title="No leads ready for admission" description="Leads must be Interested, Demo Booked or Follow-up before they can be enrolled." />
          ) : (
            eligible.map((l) => (
              <button key={l.id} type="button" className="adm-pick" aria-pressed={leadId === l.id} onClick={() => setLeadId(l.id)}>
                <span className="adm-pick__name">{leadName(l)}</span>
                <span className="adm-pick__sub">{academicLine(l) ?? l.parent.whatsappNumber}</span>
                {l.aiScore !== null && <span className="adm-pick__score">AI {l.aiScore}</span>}
              </button>
            ))
          )}
        </div>
      )}

      {step === 1 && (
        <div className="adm-form-grid">
          {serverError && (
            <div className="adm-form-error adm-span-all" role="alert">
              {serverError}
            </div>
          )}
          <Input label="Student name" required value={studentName} onChange={(e) => setStudentName(e.target.value)} error={errors.studentName} wrapperClassName="adm-span-all" autoComplete="off" />
          <DateInput label="Date of birth" value={dob} onChange={(e) => setDob(e.target.value)} error={errors.dateOfBirth} />
          <div>
            {batches.isPending ? (
              <Spinner label="Loading batches" />
            ) : batches.isError ? (
              <ErrorState error={batches.error} onRetry={() => void batches.refetch()} retrying={batches.isFetching} title="Could not load batches" />
            ) : (
              <Select
                label="Batch"
                value={batchId}
                onChange={(e) => setBatchId(e.target.value)}
                placeholder={batches.data.length ? 'No batch yet' : 'No batches exist yet'}
                options={batches.data.map((b) => ({ value: b.id, label: batchLabel(b) }))}
                error={errors.batchId}
                hint="Optional. You can enroll into a batch later."
              />
            )}
          </div>
          <Input label="Payment reference" required value={reference} onChange={(e) => setReference(e.target.value)} error={errors.paymentReference} autoComplete="off" />
          <Input label="Amount paid" required type="number" min={0} step="any" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} error={errors.amountPaid} />
          <Select label="Payment mode" value={mode} onChange={(e) => setMode(e.target.value)} options={PAYMENT_MODES.map((m) => ({ value: m, label: m }))} error={errors.paymentMode} />
        </div>
      )}

      {step === 2 && lead && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <dl className="adm-summary">
            <dt>Lead (parent)</dt>
            <dd style={{ fontWeight: 600 }}>{leadName(lead)}</dd>
            <dt>Student</dt>
            <dd>{studentName.trim()}</dd>
            {dob && (
              <>
                <dt>Date of birth</dt>
                <dd>{dob}</dd>
              </>
            )}
            <dt>Batch</dt>
            <dd>{batch ? batchLabel(batch) : 'None selected'}</dd>
            <dt>Payment</dt>
            <dd>
              {amountNum} via {mode} · ref {reference.trim()}
            </dd>
          </dl>
          <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-muted)' }}>
            Confirming creates the student, records the payment, enrolls them in the batch and moves the lead to Admission. A WhatsApp welcome message is queued automatically.
          </p>
        </div>
      )}
    </Modal>
  );
}
