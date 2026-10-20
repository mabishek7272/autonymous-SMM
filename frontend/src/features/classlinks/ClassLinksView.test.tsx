import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../test/renderWithProviders';
import { ApiError } from '../../services/http';
import ClassLinksView from './ClassLinksView';

const m = vi.hoisted(() => ({
  list: vi.fn(), create: vi.fn(), bulk: vi.fn(), update: vi.fn(), remove: vi.fn(),
  batches: vi.fn(), updateBatch: vi.fn(), setSchedule: vi.fn(), timetableImport: vi.fn(),
}));
vi.mock('../../services/api', () => ({
  api: {
    classLinks: { list: m.list, create: m.create, bulk: m.bulk, update: m.update, remove: m.remove, timetableImport: m.timetableImport },
    academic: { batches: m.batches, updateBatch: m.updateBatch, setSchedule: m.setSchedule },
  },
}));

const TEAMS = 'https://teams.microsoft.com/l/meetup-join/abc';
const link = (o = {}) => ({
  id: 'l1', name: '8th CBSE Science', meetingUrl: TEAMS, grade: '8', board: 'CBSE', subject: 'Science', isActive: true,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', _count: { batches: 0 }, ...o,
});
const batch = (o = {}) => ({
  id: 'b1', courseId: 'c1', batchName: '8-CBSE-Science', startDate: null, endDate: null, teacherId: 't1', classLinkId: null,
  course: { id: 'c1', courseName: 'Class 8 CBSE' }, teacher: { id: 't1', fullName: 'Mrs Teacher', email: 't@x.test' },
  classLink: null, schedules: [], enrollments: [], ...o,
});

beforeEach(() => {
  vi.clearAllMocks();
  m.list.mockResolvedValue({ data: [link(), link({ id: 'l2', name: '9th CBSE Maths', _count: { batches: 2 } })] });
  m.batches.mockResolvedValue([batch()]);
});

describe('ClassLinksView — library', () => {
  it('lists the standing links with usage', async () => {
    renderWithProviders(<ClassLinksView />, { user: { role: 'manager' } });
    expect(await screen.findByText('8th CBSE Science')).toBeInTheDocument();
    expect(screen.getByText('9th CBSE Maths')).toBeInTheDocument();
    expect(screen.getByText('Unused')).toBeInTheDocument();
  });

  it('is only for users with classlinks:manage', () => {
    renderWithProviders(<ClassLinksView />, { user: { role: 'teacher' } });
    expect(screen.getByText('No access')).toBeInTheDocument();
    expect(m.list).not.toHaveBeenCalled();
  });

  it('shows the server error with Retry, and a real empty state', async () => {
    m.list.mockRejectedValueOnce(new ApiError(500, 'DB exploded'));
    renderWithProviders(<ClassLinksView />, { user: { role: 'manager' } });
    expect(await screen.findByText('DB exploded')).toBeInTheDocument();
    m.list.mockResolvedValue({ data: [] });
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No class links yet')).toBeInTheDocument();
  });

  it('adds a link, validating https first', async () => {
    m.create.mockResolvedValue(link({ id: 'l3', name: '10th CBSE Maths' }));
    renderWithProviders(<ClassLinksView />, { user: { role: 'manager' } });
    await screen.findByText('8th CBSE Science');
    await userEvent.click(screen.getByRole('button', { name: 'Add link' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(/Name/), '10th CBSE Maths');
    await userEvent.type(within(dialog).getByLabelText(/Meeting link/), 'http://insecure.example');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add link' }));
    expect(await within(dialog).findByText(/must start with https/)).toBeInTheDocument();
    expect(m.create).not.toHaveBeenCalled();

    await userEvent.clear(within(dialog).getByLabelText(/Meeting link/));
    await userEvent.type(within(dialog).getByLabelText(/Meeting link/), TEAMS);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add link' }));
    await waitFor(() => expect(m.create).toHaveBeenCalledWith({ name: '10th CBSE Maths', meetingUrl: TEAMS, grade: null, board: null, subject: null }));
  });

  it('imports pasted rows in one call and reports bad rows before importing', async () => {
    m.bulk.mockResolvedValue({ created: 2, updated: 0, total: 2 });
    renderWithProviders(<ClassLinksView />, { user: { role: 'manager' } });
    await screen.findByText('8th CBSE Science');
    await userEvent.click(screen.getByRole('button', { name: 'Import links' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByLabelText('Rows'));
    await userEvent.paste(`A One\t${TEAMS}\t8\tCBSE\tScience\nBad row\thttp://nope\nB Two\t${TEAMS}-2`);
    expect(await within(dialog).findByText(/2 valid links/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Row 2: Second column must be an https link/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Import 2 links' }));
    await waitFor(() =>
      expect(m.bulk).toHaveBeenCalledWith([
        { name: 'A One', meetingUrl: TEAMS, grade: '8', board: 'CBSE', subject: 'Science' },
        { name: 'B Two', meetingUrl: `${TEAMS}-2`, grade: null, board: null, subject: null },
      ]),
    );
  });

  it('deactivates a link and disables deleting one that batches use', async () => {
    m.update.mockResolvedValue(link({ isActive: false }));
    renderWithProviders(<ClassLinksView />, { user: { role: 'manager' } });
    await screen.findByText('8th CBSE Science');
    expect(screen.getByRole('button', { name: 'Delete 9th CBSE Maths' })).toBeDisabled();
    await userEvent.click(screen.getByRole('switch', { name: '8th CBSE Science active' }));
    await waitFor(() => expect(m.update).toHaveBeenCalledWith('l1', { isActive: false }));
  });
});

describe('ClassLinksView — batch links and timetable', () => {
  const openBatches = async () => {
    renderWithProviders(<ClassLinksView />, { user: { role: 'manager' } });
    await screen.findByText('8th CBSE Science');
    await userEvent.click(screen.getByRole('tab', { name: /Batch links/ }));
    return screen.findByText('8-CBSE-Science');
  };

  it('assigns a standing link to a batch', async () => {
    m.updateBatch.mockResolvedValue(batch({ classLinkId: 'l1', classLink: { id: 'l1', name: '8th CBSE Science', meetingUrl: TEAMS, isActive: true } }));
    await openBatches();
    await userEvent.selectOptions(screen.getByLabelText('Standing class link'), 'l1');
    await waitFor(() => expect(m.updateBatch).toHaveBeenCalledWith('b1', { classLinkId: 'l1' }));
  });

  it('saves the weekly timetable and warns when no link is assigned', async () => {
    m.setSchedule.mockResolvedValue([{ id: 's1', batchId: 'b1', dayOfWeek: 1, startTime: '17:00', durationMinutes: 60 }]);
    await openBatches();
    await userEvent.click(screen.getByRole('button', { name: 'Add slot' }));
    expect(screen.getByText(/Assign a class link above/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save timetable' }));
    await waitFor(() => expect(m.setSchedule).toHaveBeenCalledWith('b1', [{ dayOfWeek: 1, startTime: '17:00', durationMinutes: 60, classLinkId: null }]));
  });

  it('blocks saving a duplicate slot', async () => {
    await openBatches();
    await userEvent.click(screen.getByRole('button', { name: 'Add slot' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add slot' }));
    expect(screen.getByText(/same day and time/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save timetable' })).toBeDisabled();
  });
});


describe('ClassLinksView — slot links and timetable import', () => {
  it('lets one slot use a different room than the batch link', async () => {
    m.batches.mockResolvedValue([
      batch({
        classLinkId: 'l1',
        classLink: { id: 'l1', name: '8th CBSE Science', meetingUrl: TEAMS, isActive: true },
        schedules: [{ id: 's1', batchId: 'b1', dayOfWeek: 5, startTime: '19:30', durationMinutes: 60, classLinkId: null }],
      }),
    ]);
    m.setSchedule.mockResolvedValue([]);
    renderWithProviders(<ClassLinksView />, { user: { role: 'manager' } });
    await screen.findByText('8th CBSE Science');
    await userEvent.click(screen.getByRole('tab', { name: /Batch links/ }));
    await userEvent.selectOptions(await screen.findByLabelText('Link for slot 1'), 'l2');
    await userEvent.click(screen.getByRole('button', { name: 'Save timetable' }));
    await waitFor(() => expect(m.setSchedule).toHaveBeenCalledWith('b1', [{ dayOfWeek: 5, startTime: '19:30', durationMinutes: 60, classLinkId: 'l2' }]));
  });

  it('previews a pasted timetable, then imports it', async () => {
    m.timetableImport.mockImplementation(async (_rows: unknown, dryRun: boolean) => ({ dryRun, batches: 2, batchesToCreate: 2, links: 2, linksToCreate: 1, slots: 2 }));
    renderWithProviders(<ClassLinksView />, { user: { role: 'manager' } });
    await screen.findByText('8th CBSE Science');
    await userEvent.click(screen.getByRole('button', { name: 'Import timetable' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByLabelText('Timetable'));
    await userEvent.paste(`Monday\t6:30 – 7:30 PM\tXII Chem\tHML\t${TEAMS}\n\t7:30 – 8:30 PM\tXII Math\tSRI\t${TEAMS}-2`);
    expect(await within(dialog).findByText(/2 batches \(2 new\), 2 links \(1 new\)/)).toBeInTheDocument();
    expect(m.timetableImport).toHaveBeenLastCalledWith(
      [
        { batchName: 'XII Chem', day: 'Monday', startTime: '6:30 PM', endTime: '7:30 PM', meetingUrl: TEAMS },
        { batchName: 'XII Math', day: 'Monday', startTime: '7:30 PM', endTime: '8:30 PM', meetingUrl: `${TEAMS}-2` },
      ],
      true,
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Import 2 slots' }));
    await waitFor(() => expect(m.timetableImport).toHaveBeenLastCalledWith(expect.any(Array), false));
    expect(await screen.findByText(/Timetable imported: 2 batch/)).toBeInTheDocument();
  });

  it('blocks importing while lines are unreadable', async () => {
    renderWithProviders(<ClassLinksView />, { user: { role: 'manager' } });
    await screen.findByText('8th CBSE Science');
    await userEvent.click(screen.getByRole('button', { name: 'Import timetable' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByLabelText('Timetable'));
    await userEvent.paste('Monday\t6:30 – 7:30 PM\tXII Chem\tHML\t');
    expect(await within(dialog).findByText(/Meeting link is missing/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Import' })).toBeDisabled();
    expect(m.timetableImport).not.toHaveBeenCalled();
  });
});
