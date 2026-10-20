import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../services/api';
import { getErrorMessage, getFieldErrors } from '../../services/http';
import type { ClassLinkWithUsage } from '../../types';
import { Button, Input, Modal, useToast } from '../../ui';
import { classLinkKeys } from './hooks';

interface Props {
  link: ClassLinkWithUsage | null;
  onClose: () => void;
}

export function LinkFormModal({ link, onClose }: Props) {
  const toast = useToast();
  const qc = useQueryClient();
  const editing = link !== null;
  const [name, setName] = useState(link?.name ?? '');
  const [url, setUrl] = useState(link?.meetingUrl ?? '');
  const [grade, setGrade] = useState(link?.grade ?? '');
  const [board, setBoard] = useState(link?.board ?? '');
  const [subject, setSubject] = useState(link?.subject ?? '');
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});

  const save = useMutation({
    mutationFn: () => {
      const input = {
        name: name.trim(),
        meetingUrl: url.trim(),
        grade: grade.trim() || null,
        board: board.trim() || null,
        subject: subject.trim() || null,
      };
      return link ? api.classLinks.update(link.id, input) : api.classLinks.create(input);
    },
    onSuccess: (saved) => {
      toast.success(editing ? `Updated "${saved.name}"` : `Added "${saved.name}"`);
      void qc.invalidateQueries({ queryKey: classLinkKeys.list });
      void qc.invalidateQueries({ queryKey: classLinkKeys.batches });
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
    if (name.trim().length < 2) next.name = 'Enter a name, e.g. "8th CBSE Science"';
    try {
      if (new URL(url.trim()).protocol !== 'https:') next.meetingUrl = 'Link must start with https://';
    } catch {
      next.meetingUrl = 'Enter a valid link';
    }
    setErrors(next);
    if (Object.values(next).some(Boolean)) return;
    save.mutate();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={editing ? 'Edit class link' : 'Add class link'}
      subtitle="A standing meeting link that stays the same for the whole class journey"
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="cl-link-form" loading={save.isPending} disabled={save.isPending}>
            {editing ? 'Save changes' : 'Add link'}
          </Button>
        </>
      }
    >
      <form id="cl-link-form" className="cl__form" onSubmit={submit} noValidate>
        <Input wrapperClassName="cl__full" label="Name" required value={name} onChange={(e) => setName(e.target.value)} error={errors.name} placeholder="8th CBSE Science" />
        <Input wrapperClassName="cl__full" label="Meeting link" type="url" required value={url} onChange={(e) => setUrl(e.target.value)} error={errors.meetingUrl} placeholder="https://teams.microsoft.com/l/meetup-join/..." />
        <Input label="Class (optional)" value={grade} onChange={(e) => setGrade(e.target.value)} error={errors.grade} placeholder="8" />
        <Input label="Board (optional)" value={board} onChange={(e) => setBoard(e.target.value)} error={errors.board} placeholder="CBSE" />
        <Input wrapperClassName="cl__full" label="Subject (optional)" value={subject} onChange={(e) => setSubject(e.target.value)} error={errors.subject} placeholder="Science" />
      </form>
    </Modal>
  );
}
