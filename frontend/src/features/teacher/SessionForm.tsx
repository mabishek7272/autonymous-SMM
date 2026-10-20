import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../services/api';
import { getErrorMessage, getFieldErrors } from '../../services/http';
import type { BatchDetail, ClassSessionWithBatch } from '../../types';
import { Button, Input, Modal, Textarea, useToast } from '../../ui';
import { batchLabel, validateMeetingUrl } from './helpers';
import { isoToIstLocalInput, istLocalInputToIso } from './dates';
import { teacherKeys } from './hooks';

interface Errors {
  topic?: string;
  startsAt?: string;
  durationMinutes?: string;
  meetingUrl?: string;
}

interface Props {
  batch: BatchDetail;
  session: ClassSessionWithBatch | null;
  onClose: () => void;
}

export function SessionFormModal({ batch, session, onClose }: Props) {
  const toast = useToast();
  const qc = useQueryClient();
  const editing = session !== null;
  // A batch with a standing link (e.g. its Teams room) needs no pasted link for a normal class.
  const standing = batch.classLink?.isActive ? batch.classLink : null;
  const optionalUrl = !editing && standing !== null;
  const [topic, setTopic] = useState(session?.topic ?? '');
  const [startsAt, setStartsAt] = useState(session ? isoToIstLocalInput(session.startsAt) : '');
  const [duration, setDuration] = useState(String(session?.durationMinutes ?? 60));
  const [url, setUrl] = useState(session?.meetingUrl ?? '');
  const [notes, setNotes] = useState(session?.notes ?? '');
  const [errors, setErrors] = useState<Errors>({});

  const save = useMutation({
    mutationFn: () => {
      const base = {
        topic: topic.trim(),
        startsAt: istLocalInputToIso(startsAt),
        durationMinutes: Number(duration),
        meetingUrl: url.trim(),
        notes: notes.trim(),
      };
      if (session) {
        return api.sessions.update(session.id, {
          topic: base.topic || null,
          startsAt: base.startsAt,
          durationMinutes: base.durationMinutes,
          meetingUrl: base.meetingUrl,
          notes: base.notes || null,
        });
      }
      return api.sessions.create({
        batchId: batch.id,
        startsAt: base.startsAt,
        durationMinutes: base.durationMinutes,
        ...(base.meetingUrl ? { meetingUrl: base.meetingUrl } : {}),
        ...(base.topic ? { topic: base.topic } : {}),
        ...(base.notes ? { notes: base.notes } : {}),
      });
    },
    onSuccess: (res) => {
      toast.success(editing ? `Class link updated for ${batchLabel(batch)}` : `Class link added for ${res.batch.batchName ?? batchLabel(batch)}`);
      void qc.invalidateQueries({ queryKey: teacherKeys.sessions(batch.id) });
      void qc.invalidateQueries({ queryKey: teacherKeys.sessionsToday });
      onClose();
    },
    onError: (err) => {
      const fe = getFieldErrors(err);
      setErrors({ topic: fe.topic, startsAt: fe.startsAt, durationMinutes: fe.durationMinutes, meetingUrl: fe.meetingUrl });
      toast.error(getErrorMessage(err));
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next: Errors = {};
    if (topic.length > 255) next.topic = 'Topic must be 255 characters or fewer';
    if (!startsAt) next.startsAt = 'Pick a date and time';
    const mins = Number(duration);
    if (!Number.isInteger(mins) || mins < 5 || mins > 480) next.durationMinutes = 'Duration must be a whole number between 5 and 480 minutes';
    next.meetingUrl = optionalUrl && !url.trim() ? undefined : validateMeetingUrl(url);
    setErrors(next);
    if (Object.values(next).some(Boolean)) return;
    save.mutate();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={editing ? 'Edit class link' : 'Add class link'}
      subtitle={`${batchLabel(batch)} · times are in IST`}
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="tp-session-form" loading={save.isPending} disabled={save.isPending}>
            {editing ? 'Save changes' : 'Add class link'}
          </Button>
        </>
      }
    >
      <form id="tp-session-form" className="tp__form" onSubmit={submit} noValidate>
        <Input wrapperClassName="tp__full" label="Topic" value={topic} onChange={(e) => setTopic(e.target.value)} error={errors.topic} placeholder="e.g. Chapter 4 revision" />
        <Input label="Date and time (IST)" type="datetime-local" required value={startsAt} onChange={(e) => setStartsAt(e.target.value)} error={errors.startsAt} />
        <Input label="Duration (minutes)" type="number" required min={5} max={480} value={duration} onChange={(e) => setDuration(e.target.value)} error={errors.durationMinutes} />
        <Input wrapperClassName="tp__full" label={optionalUrl ? 'Meeting link (optional)' : 'Meeting link'} type="url" required={!optionalUrl} value={url} onChange={(e) => setUrl(e.target.value)} error={errors.meetingUrl} hint={optionalUrl ? `Leave empty to use this batch's standing link: ${standing?.name}` : 'Must be an https meeting link (Teams or Google Meet)'} placeholder={optionalUrl ? standing?.meetingUrl : 'https://'} />
        <Textarea wrapperClassName="tp__full" label="Notes for parents (optional)" rows={2} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </form>
    </Modal>
  );
}
