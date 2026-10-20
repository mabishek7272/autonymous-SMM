import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/useAuth';
import { api, type UpdateUserInput } from '../../services/api';
import { getErrorMessage, getFieldErrors } from '../../services/http';
import { ROLE_LABELS, type Role } from '../../types/permissions';
import type { User } from '../../types';
import { Button, Input, Modal, Select, Toggle, useToast } from '../../ui';
import { passwordStrength } from './passwordStrength';
import { grantableRoles } from './rolesMatrix';

interface Props {
  open: boolean;
  onClose: () => void;
  /** When set, the modal edits this user; otherwise it creates one. */
  user?: User;
}

function PasswordHint({ value }: { value: string }) {
  const s = passwordStrength(value);
  return (
    <div className="adm-strength" aria-live="polite">
      <span className="adm-strength__bars" aria-hidden="true">
        {[1, 2, 3, 4].map((i) => (
          <span key={i} className={`adm-strength__bar${s.score >= i ? ' adm-strength__bar--on' : ''}`} />
        ))}
      </span>
      <span>Strength: {s.label} (minimum 8 characters)</span>
    </div>
  );
}

export function UserFormModal({ open, onClose, user }: Props) {
  const { user: me } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const editing = user !== undefined;
  const isSelf = editing && me?.id === user.id;
  const roles = grantableRoles(me?.role);
  const roleOptions = (editing && !roles.includes(user.role) ? [user.role, ...roles] : roles).map((r) => ({
    value: r,
    label: ROLE_LABELS[r],
    disabled: !roles.includes(r),
  }));

  const [fullName, setFullName] = useState(user?.fullName ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>(user?.role ?? 'teacher');
  const [phone, setPhone] = useState(user?.phone ?? '');
  const [initials, setInitials] = useState(user?.initials ?? '');
  const [isActive, setIsActive] = useState(user?.isActive ?? true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (): Promise<User> => {
      if (!editing) {
        return api.users.create({
          fullName: fullName.trim(),
          email: email.trim(),
          password,
          role,
          ...(phone ? { phone } : {}),
          ...(initials.trim() ? { initials: initials.trim().toUpperCase() } : {}),
        });
      }
      const patch: UpdateUserInput = {};
      if (fullName.trim() !== user.fullName) patch.fullName = fullName.trim();
      if (role !== user.role) patch.role = role;
      if (phone !== (user.phone ?? '')) patch.phone = phone === '' ? null : phone;
      if (initials !== (user.initials ?? '')) patch.initials = initials.trim() === '' ? null : initials.trim().toUpperCase();
      if (isActive !== user.isActive) patch.isActive = isActive;
      if (password) patch.password = password;
      return api.users.update(user.id, patch);
    },
    onSuccess: (saved) => {
      toast.success(editing ? `Updated ${saved.fullName}` : `Added ${saved.fullName}`);
      void qc.invalidateQueries({ queryKey: ['users'] });
      onClose();
    },
    onError: (err) => {
      const fields = getFieldErrors(err);
      setErrors({ fullName: fields.fullName ?? '', email: fields.email ?? '', password: fields.password ?? '', phone: fields.phone ?? '' });
      const msg = getErrorMessage(err);
      setFormError(msg);
      toast.error(msg);
    },
  });

  const validate = (): boolean => {
    const next: Record<string, string> = {};
    if (fullName.trim().length < 2) next.fullName = 'Enter the full name (at least 2 characters).';
    if (!editing && !/^\S+@\S+\.\S+$/.test(email.trim())) next.email = 'Enter a valid email address.';
    if ((!editing || password) && !passwordStrength(password).valid) next.password = 'Password must be 8 to 128 characters.';
    if (phone && !/^\d{10,15}$/.test(phone)) next.phone = 'Digits only, 10 to 15, including the country code.';
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (validate()) mutation.mutate();
  };

  const dirty =
    !editing ||
    fullName.trim() !== user.fullName ||
    role !== user.role ||
    phone !== (user.phone ?? '') ||
    initials !== (user.initials ?? '') ||
    isActive !== user.isActive ||
    password !== '';

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? `Edit ${user.fullName}` : 'Add user'}
      subtitle={editing ? user.email : 'They can sign in with this email and password straight away.'}
      width={520}
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="user-form" loading={mutation.isPending} disabled={!dirty}>
            {editing ? 'Save changes' : 'Add user'}
          </Button>
        </>
      }
    >
      <form id="user-form" className="adm-form" onSubmit={submit} noValidate>
        {formError && (
          <div className="adm-banner adm-banner--bad" role="alert">
            {formError}
          </div>
        )}
        <Input label="Full name" required value={fullName} onChange={(e) => setFullName(e.target.value)} error={errors.fullName || undefined} />
        <Input
          label="Email"
          type="email"
          required
          value={email}
          readOnly={editing}
          disabled={editing}
          hint={editing ? 'Email cannot be changed.' : undefined}
          onChange={(e) => setEmail(e.target.value)}
          error={errors.email || undefined}
        />
        <Input
          label={editing ? 'Reset password' : 'Password'}
          type="password"
          required={!editing}
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          hint={editing ? 'Leave blank to keep the current password.' : undefined}
          error={errors.password || undefined}
        />
        {(password || !editing) && <PasswordHint value={password} />}
        <div className="adm-grid-2">
          <Select
            label="Role"
            value={role}
            options={roleOptions}
            disabled={isSelf}
            hint={isSelf ? 'You cannot change your own role.' : undefined}
            onChange={(e) => setRole(e.target.value as Role)}
          />
          <Input
            label="Phone (optional)"
            inputMode="numeric"
            value={phone}
            placeholder="Digits with country code"
            onChange={(e) => setPhone(e.target.value.replace(/\s+/g, ''))}
            error={errors.phone || undefined}
          />
        </div>
        {role === 'teacher' && (
          <Input
            label="Initials (optional)"
            value={initials}
            maxLength={10}
            placeholder="e.g. BPY — as written on the timetable"
            onChange={(e) => setInitials(e.target.value.toUpperCase())}
          />
        )}
        {editing && (
          <Toggle
            checked={isActive}
            onChange={setIsActive}
            label={isActive ? 'Account active' : 'Account deactivated'}
            disabled={isSelf}
          />
        )}
        {isSelf && <span className="adm-muted">You cannot deactivate your own account.</span>}
      </form>
    </Modal>
  );
}
