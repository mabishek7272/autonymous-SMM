import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../test/renderWithProviders';
import { ImportTeachersModal } from './ImportTeachersModal';

const m = vi.hoisted(() => ({ importTeachers: vi.fn(), batches: vi.fn(), downloadTextFile: vi.fn() }));
vi.mock('../../services/api', () => ({ api: { users: { importTeachers: m.importTeachers }, academic: { batches: m.batches } } }));
vi.mock('../imports/csv', async (orig) => ({ ...(await orig<typeof import('../imports/csv')>()), downloadTextFile: m.downloadTextFile }));

const preview = (o = {}) => ({ dryRun: true, created: 1, existing: 0, batchesAssigned: 2, invalid: [], warnings: [], credentials: [], emailed: 0, ...o });

beforeEach(() => {
  vi.clearAllMocks();
  m.batches.mockResolvedValue([{ id: 'b1', batchName: 'XII Chem' }, { id: 'b2', batchName: 'XII Math' }]);
});

describe('ImportTeachersModal', () => {
  it('previews, imports, then shows the temporary passwords once with a download', async () => {
    m.importTeachers.mockImplementation(async (_rows: unknown, dryRun: boolean) =>
      dryRun ? preview() : { ...preview({ dryRun: false, emailed: 1 }), credentials: [{ email: 'priya@example.com', fullName: 'Priya Sharma', password: 'abc123XYZ' }] },
    );
    renderWithProviders(<ImportTeachersModal onClose={() => undefined} />, { user: { role: 'admin' } });
    expect(await screen.findByText('Available batch names (2)')).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText('Teachers'));
    await userEvent.paste('Priya Sharma\tpriya@example.com\t9876543210\tPKS\tXII Chem; XII Math');
    expect(await screen.findByText(/1 new, 0 existing, 2 batch assignments/)).toBeInTheDocument();
    expect(m.importTeachers).toHaveBeenLastCalledWith(
      [{ fullName: 'Priya Sharma', email: 'priya@example.com', phone: '9876543210', initials: 'PKS', batches: 'XII Chem; XII Math', password: undefined }],
      true,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Import 1 teacher' }));
    expect(await screen.findByText('Teachers imported')).toBeInTheDocument();
    expect(screen.getByText('abc123XYZ')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/only once/);
    expect(screen.getByText(/1 login email sent from security@e-kalavya.com/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Download logins (CSV)' }));
    expect(m.downloadTextFile).toHaveBeenCalledWith('teacher-logins.csv', expect.stringContaining('priya@example.com,abc123XYZ'));
  });

  it('shows problem rows from the server and blocks an empty import', async () => {
    m.importTeachers.mockResolvedValue(preview({ created: 0, batchesAssigned: 0, invalid: [{ row: 1, message: 'Priya: unknown batch(es) "XII Bio"' }] }));
    renderWithProviders(<ImportTeachersModal onClose={() => undefined} />, { user: { role: 'admin' } });
    await userEvent.click(await screen.findByLabelText('Teachers'));
    await userEvent.paste('Priya\tpriya@example.com\t9876543210\t\tXII Bio');
    expect(await screen.findByText(/unknown batch\(es\) "XII Bio"/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();
  });

  it('flags unreadable lines locally before calling the server', async () => {
    renderWithProviders(<ImportTeachersModal onClose={() => undefined} />, { user: { role: 'admin' } });
    await userEvent.click(await screen.findByLabelText('Teachers'));
    await userEvent.paste('No Email\t\t9876543210');
    expect(await screen.findByText(/email is missing or invalid/)).toBeInTheDocument();
    await waitFor(() => expect(m.importTeachers).not.toHaveBeenCalled());
  });
});
