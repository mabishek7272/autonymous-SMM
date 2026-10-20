import { useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '../services/api';
import { getErrorMessage, getFieldErrors } from '../services/http';
import { Button, Input, Modal, useToast } from '../ui';

export function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});

  const save = useMutation({
    mutationFn: () => api.auth.changePassword(current, next),
    onSuccess: () => {
      toast.success('Password changed');
      onClose();
    },
    onError: (err) => {
      setErrors(getFieldErrors(err));
      toast.error(getErrorMessage(err));
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v: Record<string, string | undefined> = {};
    if (!current) v.currentPassword = 'Enter your current password';
    if (next.length < 8) v.newPassword = 'Use at least 8 characters';
    else if (next === current) v.newPassword = 'Choose a password different from the current one';
    if (confirm !== next) v.confirm = 'The two passwords do not match';
    setErrors(v);
    if (Object.values(v).some(Boolean)) return;
    save.mutate();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Change password"
      width={440}
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="change-password-form" loading={save.isPending} disabled={save.isPending}>
            Change password
          </Button>
        </>
      }
    >
      <form id="change-password-form" onSubmit={submit} noValidate style={{ display: 'grid', gap: 12 }}>
        <Input label="Current password" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} error={errors.currentPassword} />
        <Input label="New password" type="password" autoComplete="new-password" required value={next} onChange={(e) => setNext(e.target.value)} error={errors.newPassword} hint="At least 8 characters" />
        <Input label="Confirm new password" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} error={errors.confirm} />
      </form>
    </Modal>
  );
}
