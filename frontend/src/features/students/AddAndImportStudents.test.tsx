import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../test/renderWithProviders';
import type { BatchDetail } from '../../types';
import { AddStudentModal } from './AddStudentModal';
import { ImportStudentsModal } from './ImportStudentsModal';

const m = vi.hoisted(() => ({ register: vi.fn(), importRows: vi.fn() }));
vi.mock('../../services/api', () => ({ students: { register: m.register, importRows: m.importRows } }));

const batches = [{ id: 'b1', batchName: 'XII Chem' }, { id: 'b2', batchName: 'XII Math' }] as unknown as BatchDetail[];

beforeEach(() => vi.clearAllMocks());

describe('AddStudentModal', () => {
  it('registers a student with parent details and the chosen batches', async () => {
    m.register.mockResolvedValue({ student: { fullName: 'Teja Sree' }, created: true, enrollmentsAdded: 2 });
    renderWithProviders(<AddStudentModal open onClose={() => undefined} batches={batches} />, { user: { role: 'admin' } });
    const d = screen.getByRole('dialog');
    await userEvent.type(within(d).getByLabelText(/Student name/), 'Teja Sree');
    await userEvent.type(within(d).getByLabelText(/Parent name/), 'Suresh Kumar');
    await userEvent.type(within(d).getByLabelText(/Parent WhatsApp number/), '9876543210');
    await userEvent.type(within(d).getByLabelText('Class'), '12');
    await userEvent.type(within(d).getByLabelText('Board'), 'CBSE');
    await userEvent.click(within(d).getByLabelText('XII Chem'));
    await userEvent.click(within(d).getByLabelText('XII Math'));
    await userEvent.click(within(d).getByRole('button', { name: 'Add student' }));
    await waitFor(() =>
      expect(m.register).toHaveBeenCalledWith({
        studentName: 'Teja Sree', parentPhone: '9876543210', parentName: 'Suresh Kumar', grade: '12', board: 'CBSE', batches: 'XII Chem; XII Math',
      }),
    );
    expect(await screen.findByText('Teja Sree registered')).toBeInTheDocument();
  });

  it('validates locally before calling the server', async () => {
    renderWithProviders(<AddStudentModal open onClose={() => undefined} batches={batches} />, { user: { role: 'admin' } });
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add student' }));
    expect(await screen.findByText(/Enter the student’s name/)).toBeInTheDocument();
    expect(screen.getByText(/parent’s WhatsApp number/)).toBeInTheDocument();
    expect(m.register).not.toHaveBeenCalled();
  });

  it('points to the timetable import when there are no batches yet', () => {
    renderWithProviders(<AddStudentModal open onClose={() => undefined} batches={[]} />, { user: { role: 'admin' } });
    expect(screen.getByText(/Import the timetable first/)).toBeInTheDocument();
  });
});

describe('ImportStudentsModal', () => {
  it('previews then imports pasted students', async () => {
    m.importRows.mockImplementation(async (_r: unknown, dryRun: boolean) => ({
      dryRun, created: 2, existing: 0, newParents: 1, enrollmentsAdded: 3, invalid: [], warnings: [], studentIds: [],
    }));
    renderWithProviders(<ImportStudentsModal onClose={() => undefined} batches={batches} />, { user: { role: 'admin' } });
    await userEvent.click(screen.getByLabelText('Students'));
    await userEvent.paste('Teja Sree\tSuresh Kumar\t9876543210\t\t12\tCBSE\t\t\tXII Chem; XII Math\nLayana\t\t9876543210\t\t12\tCBSE\t\t\tXII Chem');
    expect(await screen.findByText(/2 new, 0 existing, 1 new parent, 3 batch enrolments/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Import 2 students' }));
    await waitFor(() => expect(m.importRows).toHaveBeenLastCalledWith(expect.any(Array), false));
    expect(await screen.findByText(/2 students added/)).toBeInTheDocument();
  });

  it('shows which rows the server rejected', async () => {
    m.importRows.mockResolvedValue({ dryRun: true, created: 0, existing: 0, newParents: 0, enrollmentsAdded: 0, invalid: [{ row: 1, message: 'Kid: unknown batch(es) "XII Bio"' }], warnings: [], studentIds: [] });
    renderWithProviders(<ImportStudentsModal onClose={() => undefined} batches={batches} />, { user: { role: 'admin' } });
    await userEvent.click(screen.getByLabelText('Students'));
    await userEvent.paste('Kid\tParent\t9876543210\t\t12\tCBSE\t\t\tXII Bio');
    expect(await screen.findByText(/unknown batch\(es\) "XII Bio"/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();
  });
});
