import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../test/renderWithProviders';
import { ApiError } from '../../services/http';
import type { User } from '../../types';
import UsersView from './UsersView';

const { list, create, update } = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), update: vi.fn() }));
vi.mock('../../services/api', () => ({ api: { users: { list, create, update } } }));

const u = (o: Partial<User>): User => ({
  id: 'u-x', fullName: 'Staff Person', email: 'staff@example.test', role: 'teacher', phone: null, initials: null, isActive: true, createdAt: '2026-01-01T00:00:00.000Z', ...o,
});
const rows = [
  u({ id: 'user-1', fullName: 'Test User', email: 'test.user@example.test', role: 'admin' }),
  u({ id: 'u-2', fullName: 'Teacher Two', email: 't2@example.test', phone: '919800000000' }),
];

beforeEach(() => {
  vi.clearAllMocks();
  list.mockResolvedValue({ data: rows });
});

describe('UsersView', () => {
  it('shows loading then users', async () => {
    renderWithProviders(<UsersView />);
    expect(screen.getByRole('status', { name: 'Loading users' })).toBeInTheDocument();
    expect(await screen.findByText('Teacher Two')).toBeInTheDocument();
    expect(screen.getByText('919800000000')).toBeInTheDocument();
  });

  it('shows error with server message and retries', async () => {
    list.mockRejectedValueOnce(new ApiError(500, 'DB exploded'));
    renderWithProviders(<UsersView />);
    expect(await screen.findByText('DB exploded')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Teacher Two')).toBeInTheDocument();
  });

  it('shows an empty state', async () => {
    list.mockResolvedValue({ data: [] });
    renderWithProviders(<UsersView />);
    expect(await screen.findByText('No users yet')).toBeInTheDocument();
  });

  it('is gated by users:manage', () => {
    renderWithProviders(<UsersView />, { user: { role: 'teacher' } });
    expect(screen.getByText('No access')).toBeInTheDocument();
    expect(list).not.toHaveBeenCalled();
  });

  it('creates a user, limiting roles for non-superadmins', async () => {
    create.mockResolvedValue(u({ fullName: 'New Person' }));
    renderWithProviders(<UsersView />);
    await screen.findByText('Teacher Two');
    await userEvent.click(screen.getByRole('button', { name: 'Add user' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByRole('option', { name: 'Super Admin' })).not.toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText(/Full name/), 'New Person');
    await userEvent.type(within(dialog).getByLabelText(/^Email/), 'new@example.test');
    await userEvent.type(within(dialog).getByLabelText(/^Password/), 'abcdEFGH12');
    expect(within(dialog).getByText(/Strength: /)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add user' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith({ fullName: 'New Person', email: 'new@example.test', password: 'abcdEFGH12', role: 'teacher' }));
    expect(await screen.findByText('Added New Person')).toBeInTheDocument();
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });

  it('offers superadmin only to a superadmin', async () => {
    renderWithProviders(<UsersView />, { user: { role: 'superadmin' } });
    await screen.findByText('Teacher Two');
    await userEvent.click(screen.getByRole('button', { name: 'Add user' }));
    expect(within(screen.getByRole('dialog')).getByRole('option', { name: 'Super Admin' })).toBeInTheDocument();
  });

  it('rejects an invalid phone client-side and surfaces a 409 from the server', async () => {
    create.mockRejectedValue(new ApiError(409, 'User with this email already exists'));
    renderWithProviders(<UsersView />);
    await screen.findByText('Teacher Two');
    await userEvent.click(screen.getByRole('button', { name: 'Add user' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(/Full name/), 'Dup Person');
    await userEvent.type(within(dialog).getByLabelText(/^Email/), 'dup@example.test');
    await userEvent.type(within(dialog).getByLabelText(/^Password/), 'abcdEFGH12');
    await userEvent.type(within(dialog).getByLabelText(/Phone/), '12ab');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add user' }));
    expect(await within(dialog).findByText(/Digits only/)).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
    await userEvent.clear(within(dialog).getByLabelText(/Phone/));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add user' }));
    expect(await within(dialog).findByText('User with this email already exists')).toBeInTheDocument();
  });

  it('edits a user sending only changed fields', async () => {
    update.mockResolvedValue(u({ id: 'u-2', fullName: 'Teacher Two', role: 'manager' }));
    renderWithProviders(<UsersView />);
    await screen.findByText('Teacher Two');
    await userEvent.click(screen.getByRole('button', { name: 'Edit Teacher Two' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.selectOptions(within(dialog).getByLabelText('Role'), 'manager');
    await userEvent.type(within(dialog).getByLabelText(/Reset password/), 'newPassw0rd');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith('u-2', { role: 'manager', password: 'newPassw0rd' }));
    expect(await screen.findByText('Updated Teacher Two')).toBeInTheDocument();
  });

  it('deactivates after confirmation and shows server errors', async () => {
    update.mockRejectedValue(new ApiError(403, 'Only a superadmin can modify superadmins'));
    renderWithProviders(<UsersView />);
    await screen.findByText('Teacher Two');
    await userEvent.click(screen.getByRole('switch', { name: 'Teacher Two active' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith('u-2', { isActive: false }));
    expect(await screen.findByText('Only a superadmin can modify superadmins')).toBeInTheDocument();
  });

  it('does not allow deactivating your own account', async () => {
    renderWithProviders(<UsersView />);
    await screen.findByText('Teacher Two');
    expect(screen.getByRole('switch', { name: 'Test User active' })).toBeDisabled();
  });

  it('renders the roles legend', async () => {
    renderWithProviders(<UsersView />);
    expect(await screen.findByText('What each role can access')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Permissions by role' })).toBeInTheDocument();
  });
});
