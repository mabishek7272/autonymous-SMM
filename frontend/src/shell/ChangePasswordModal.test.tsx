import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../test/renderWithProviders';
import { ApiError } from '../services/http';
import { ChangePasswordModal } from './ChangePasswordModal';

const m = vi.hoisted(() => ({ changePassword: vi.fn() }));
vi.mock('../services/api', () => ({ api: { auth: { changePassword: m.changePassword } } }));

beforeEach(() => vi.clearAllMocks());

const fill = async (cur: string, next: string, conf: string) => {
  await userEvent.type(screen.getByLabelText(/Current password/), cur);
  await userEvent.type(screen.getByLabelText(/^New password/), next);
  await userEvent.type(screen.getByLabelText(/Confirm new password/), conf);
  await userEvent.click(screen.getByRole('button', { name: 'Change password' }));
};

describe('ChangePasswordModal', () => {
  it('changes the password', async () => {
    m.changePassword.mockResolvedValue(undefined);
    const onClose = vi.fn();
    renderWithProviders(<ChangePasswordModal onClose={onClose} />);
    await fill('old-password', 'brand-new-pass', 'brand-new-pass');
    await waitFor(() => expect(m.changePassword).toHaveBeenCalledWith('old-password', 'brand-new-pass'));
    expect(onClose).toHaveBeenCalled();
  });

  it('checks the confirmation and length locally', async () => {
    renderWithProviders(<ChangePasswordModal onClose={() => undefined} />);
    await fill('old-password', 'short', 'different');
    expect(await screen.findByText('Use at least 8 characters')).toBeInTheDocument();
    expect(screen.getByText('The two passwords do not match')).toBeInTheDocument();
    expect(m.changePassword).not.toHaveBeenCalled();
  });

  it('shows the server error for a wrong current password', async () => {
    m.changePassword.mockRejectedValue(new ApiError(400, 'Current password is incorrect', { fieldErrors: { currentPassword: ['Incorrect password'] } }));
    renderWithProviders(<ChangePasswordModal onClose={() => undefined} />);
    await fill('wrong-one', 'brand-new-pass', 'brand-new-pass');
    expect(await screen.findByText('Incorrect password')).toBeInTheDocument();
  });
});
