import { useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '../../services/api';
import { getFieldErrors } from '../../services/http';
import { REMINDER_TEMPLATE_PLACEHOLDERS, type ReminderRule, type ReminderRuleInput } from '../../types';
import { Button, Input, Modal, Select, Textarea, useToast } from '../../ui';
import { DAY_NAMES } from './dates';
import { unknownPlaceholders } from './template';

interface Props {
  /** null creates a new rule; a rule edits it. */
  rule: ReminderRule | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function ReminderRuleModal({ rule, open, onClose, onSaved }: Props) {
  const toast = useToast();
  const [name, setName] = useState(rule?.name ?? '');
  const [day, setDay] = useState(String(rule?.dayOfWeek ?? 1));
  const [time, setTime] = useState(rule?.timeOfDay ?? '09:00');
  const [template, setTemplate] = useState(rule?.template ?? '');
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState(false);

  const errors: Record<string, string> = {};
  if (!name.trim()) errors.name = 'Name is required';
  else if (name.trim().length > 120) errors.name = 'Name must be 120 characters or fewer';
  if (!TIME_RE.test(time)) errors.timeOfDay = 'Use 24-hour HH:mm, for example 09:00';
  const trimmed = template.trim();
  if (!trimmed) errors.template = 'Message template is required';
  else if (trimmed.length > 2000) errors.template = 'Template must be 2000 characters or fewer';
  else {
    const bad = unknownPlaceholders(trimmed);
    if (bad.length > 0) errors.template = `Unknown placeholder(s): ${bad.map((b) => `{{${b}}}`).join(', ')}`;
  }
  const shown = (field: string) => (touched ? errors[field] : undefined) ?? serverErrors[field];

  const save = useMutation({
    mutationFn: (input: ReminderRuleInput) => (rule ? api.reminders.update(rule.id, input) : api.reminders.create(input)),
    onSuccess: (saved) => {
      toast.success(rule ? `Updated "${saved.name}"` : `Created "${saved.name}"`);
      onSaved();
      onClose();
    },
    onError: (err) => {
      setServerErrors(getFieldErrors(err));
      toast.fromError(err, 'Could not save the reminder');
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    setServerErrors({});
    if (Object.keys(errors).length > 0) return;
    save.mutate({
      name: name.trim(),
      audience: rule?.audience ?? 'teacher',
      dayOfWeek: Number(day),
      timeOfDay: time,
      template: trimmed,
    });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={rule ? 'Edit reminder' : 'New teacher reminder'}
      subtitle="Sent to teachers on WhatsApp at the chosen day and time (IST)."
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="rp-rule-form" loading={save.isPending}>
            {rule ? 'Save changes' : 'Create reminder'}
          </Button>
        </>
      }
    >
      <form id="rp-rule-form" className="rp-form" onSubmit={submit} noValidate>
        <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} error={shown('name')} required />
        <div className="rp-form__row">
          <Select
            label="Day of week"
            value={day}
            onChange={(e) => setDay(e.target.value)}
            options={DAY_NAMES.map((d, i) => ({ value: String(i), label: d }))}
          />
          <Input label="Time (IST, 24-hour)" type="time" value={time} onChange={(e) => setTime(e.target.value)} error={shown('timeOfDay')} required />
        </div>
        <Textarea
          label="Message template"
          rows={5}
          value={template}
          onChange={(e) => setTemplate(e.target.value)}
          error={shown('template')}
          required
        />
        <div className="rp-phlist">
          <span>Supported placeholders:</span>
          {REMINDER_TEMPLATE_PLACEHOLDERS.map((p) => (
            <code key={p} className="rp-ph">{`{{${p}}}`}</code>
          ))}
        </div>
      </form>
    </Modal>
  );
}
