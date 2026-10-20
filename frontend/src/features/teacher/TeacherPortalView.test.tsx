import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../services/http';
import { renderWithProviders } from '../../test/renderWithProviders';
import type { AttendanceRoster, BatchDetail, BatchRosterStudent, ClassSessionWithBatch } from '../../types';
import { todayIst } from './dates';
import TeacherPortalView from './TeacherPortalView';

const apiMock = vi.hoisted(() => ({
  academic: { batches: vi.fn(), batchStudents: vi.fn(), summary: vi.fn(), createRecord: vi.fn() },
  attendance: { roster: vi.fn(), mark: vi.fn(), studentHistory: vi.fn(), notifyAbsent: vi.fn() },
  sessions: { today: vi.fn(), list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), announce: vi.fn() },
}));
vi.mock('../../services/api', () => ({ api: apiMock }));

const today = todayIst();

const batch = {
  id: 'b1',
  courseId: 'c1',
  batchName: 'Class 8 A',
  startDate: null,
  endDate: null,
  teacherId: 't1',
  course: { id: 'c1', courseName: 'CBSE 8', description: null },
  teacher: { id: 't1', fullName: 'T One', email: 't@example.test' },
  enrollments: [
    { id: 'e1', studentId: 's1', batchId: 'b1', student: { id: 's1', fullName: 'Student One', status: 'active' } },
    { id: 'e2', studentId: 's2', batchId: 'b1', student: { id: 's2', fullName: 'Student Two', status: 'active' } },
  ],
} as unknown as BatchDetail;

function roster(statuses: [AttendanceRoster['roster'][number]['status'], AttendanceRoster['roster'][number]['status']]): AttendanceRoster {
  return {
    batchId: 'b1',
    date: today,
    roster: [
      { studentId: 's1', fullName: 'Student One', studentStatus: 'active', status: statuses[0], note: null },
      { studentId: 's2', fullName: 'Student Two', studentStatus: 'active', status: statuses[1], note: null },
    ],
  };
}

function session(over: Partial<ClassSessionWithBatch> = {}): ClassSessionWithBatch {
  return {
    id: 'x1',
    batchId: 'b1',
    topic: 'Fractions',
    startsAt: `${today}T10:00:00+05:30`,
    durationMinutes: 60,
    meetingUrl: 'https://meet.example.test/abc',
    notes: null,
    createdById: 't1',
    announcedAt: null,
    createdAt: `${today}T01:00:00Z`,
    batch: { id: 'b1', batchName: 'Class 8 A' },
    ...over,
  };
}

const students = [
  {
    id: 's1',
    fullName: 'Student One',
    parent: { id: 'p1', fullName: 'Parent' },
    academicRecords: [
      { id: 'r1', studentId: 's1', subject: 'Maths', markObtained: '42.00', totalMarks: '50.00', attendancePercentage: null, testDate: `${today}T00:00:00.000Z`, teacherComments: 'Solid work', createdAt: `${today}T00:00:00.000Z` },
    ],
  },
  { id: 's2', fullName: 'Student Two', parent: { id: 'p1', fullName: 'Parent' }, academicRecords: [] },
] as unknown as BatchRosterStudent[];

const teacherPerms = ['students:read', 'attendance:mark', 'sessions:manage', 'academics:manage'] as const;

function setup(opts: { permissions?: string[] } = {}) {
  return renderWithProviders(<TeacherPortalView />, {
    user: { role: 'teacher' },
    permissions: (opts.permissions ?? [...teacherPerms]) as never,
  });
}

beforeEach(() => {
  Object.values(apiMock).forEach((ns) => Object.values(ns).forEach((fn) => fn.mockReset()));
  apiMock.academic.batches.mockResolvedValue([batch]);
  apiMock.attendance.roster.mockResolvedValue(roster([null, null]));
  apiMock.sessions.today.mockResolvedValue([session()]);
  apiMock.sessions.list.mockResolvedValue([]);
  apiMock.academic.batchStudents.mockResolvedValue(students);
  apiMock.academic.summary.mockResolvedValue({ studentId: 's1', subjectSummary: [{ subject: 'Maths', averagePercentage: 84, assessments: 3, flag: 'OK' }] });
});

describe('Teacher portal shell', () => {
  it('shows a loading state, then the empty state when no batches are assigned', async () => {
    apiMock.academic.batches.mockResolvedValue([]);
    setup();
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    expect(await screen.findByText('No batches assigned yet')).toBeInTheDocument();
    expect(screen.getByText(/Ask an admin/)).toBeInTheDocument();
  });

  it('shows the server error and retries', async () => {
    apiMock.academic.batches.mockRejectedValueOnce(new ApiError(500, 'Database unavailable'));
    setup();
    expect(await screen.findByText('Database unavailable')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Class 8 A', { selector: '.tp__batch-name' })).toBeInTheDocument();
    expect(apiMock.academic.batches).toHaveBeenCalledTimes(2);
  });

  it('renders KPIs from real counts and the batch mini-bar', async () => {
    apiMock.attendance.roster.mockResolvedValue(roster(['present', 'absent']));
    setup();
    const kpis = await screen.findByRole('region', { name: 'Key metrics' });
    await waitFor(() => expect(within(kpis).getByText('2/2')).toBeInTheDocument());
    expect(within(kpis).getByText('Batches').nextElementSibling).toHaveTextContent('1');
    expect(within(kpis).getByText('Sessions today').nextElementSibling).toHaveTextContent('1');
    expect(screen.getByRole('img', { name: /Today: 1 of 2 present, 0 unmarked/ })).toBeInTheDocument();
  });

  it('offers to notify parents of absences once attendance is saved, and reports the real result', async () => {
    apiMock.attendance.roster.mockResolvedValue(roster(['present', 'absent']));
    apiMock.attendance.notifyAbsent.mockResolvedValue({ absent: 1, notified: 1, alreadyNotified: 0, skippedOptedOut: 0, noContact: 0, failed: 0 });
    setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Notify parents of absences (1)' }));
    expect(await screen.findByText(/Each parent gets a WhatsApp message and an email/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Send notices' }));
    await waitFor(() => expect(apiMock.attendance.notifyAbsent).toHaveBeenCalledWith('b1', today));
    expect(await screen.findByText('1 parent notified')).toBeInTheDocument();
  });

  it('does not offer absence notices when nobody is absent', async () => {
    apiMock.attendance.roster.mockResolvedValue(roster(['present', 'present']));
    setup();
    await screen.findByRole('group', { name: 'Attendance for Student One' });
    expect(screen.queryByRole('button', { name: /Notify parents/ })).not.toBeInTheDocument();
  });

  it('hides tabs the permissions do not allow', async () => {
    setup({ permissions: ['students:read', 'attendance:mark'] });
    await screen.findByRole('tablist');
    expect(screen.queryByRole('tab', { name: 'Class links' })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Attendance' })).toBeInTheDocument();
    expect(apiMock.sessions.today).not.toHaveBeenCalled();
  });
});

describe('Attendance tab', () => {
  it('warns about unmarked students, marks all present and saves in bulk', async () => {
    apiMock.attendance.mark.mockResolvedValue({ batchId: 'b1', date: today, saved: 2 });
    setup();
    expect(await screen.findByText('2 students are not marked yet')).toBeInTheDocument();
    const save = screen.getByRole('button', { name: 'Save attendance' });
    expect(save).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Mark all present' }));
    await userEvent.click(screen.getByRole('button', { name: 'Mark Student Two late' }));
    await userEvent.type(screen.getByLabelText('Note for Student Two'), 'Bus delay');
    await userEvent.click(save);

    await waitFor(() =>
      expect(apiMock.attendance.mark).toHaveBeenCalledWith('b1', today, [
        { studentId: 's1', status: 'present' },
        { studentId: 's2', status: 'late', note: 'Bus delay' },
      ]),
    );
    expect(await screen.findByText(/Attendance saved for 2 students/)).toBeInTheDocument();
  });

  it('shows the server message when saving fails', async () => {
    apiMock.attendance.mark.mockRejectedValue(new ApiError(403, 'Not your batch'));
    setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Mark Student One absent' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save attendance' }));
    expect(await screen.findByText('Not your batch')).toBeInTheDocument();
  });

  it('loads a student percentage history from the backend', async () => {
    apiMock.attendance.studentHistory.mockResolvedValue({
      studentId: 's1', fullName: 'Student One', from: '', to: '', markedDays: 4, presentDays: 3, percentage: 75,
      history: [{ id: 'h1', studentId: 's1', batchId: 'b1', date: `${today}T00:00:00.000Z`, status: 'absent', note: null, markedById: null, createdAt: '', updatedAt: '', batch: { id: 'b1', batchName: 'Class 8 A' } }],
    });
    setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Attendance history for Student One' }));
    expect(await screen.findByText('75% attendance')).toBeInTheDocument();
    expect(screen.getByText('3 present or late of 4 marked days')).toBeInTheDocument();
  });

  it('does not allow future dates', async () => {
    setup();
    const date = await screen.findByLabelText('Date');
    expect(date).toHaveAttribute('max', today);
    expect(screen.getByRole('button', { name: 'Next day' })).toBeDisabled();
  });
});

describe('Class links tab', () => {
  async function openLinks() {
    setup();
    await userEvent.click(await screen.findByRole('tab', { name: 'Class links' }));
  }

  it('shows an empty state with no sessions', async () => {
    await openLinks();
    expect(await screen.findByText('No class links yet')).toBeInTheDocument();
  });

  it('shows the error state and retries', async () => {
    apiMock.sessions.list.mockRejectedValueOnce(new ApiError(500, 'Boom'));
    await openLinks();
    expect(await screen.findByText('Boom')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No class links yet')).toBeInTheDocument();
  });

  it('announces after confirmation and reports real counts', async () => {
    apiMock.sessions.list.mockResolvedValue([session()]);
    apiMock.sessions.announce.mockResolvedValue({ sessionId: 'x1', parentsMessaged: 5, parentsSkippedOptedOut: 1, teacherMessaged: true });
    await openLinks();
    await userEvent.click(await screen.findByRole('button', { name: 'Send Fractions link to parents now' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Send now' }));
    await waitFor(() => expect(apiMock.sessions.announce).toHaveBeenCalledWith('x1'));
    expect(await screen.findByText('Sent to 5 parents, 1 opted out')).toBeInTheDocument();
  });

  it('shows the 409 message when already announced', async () => {
    apiMock.sessions.list.mockResolvedValue([session()]);
    apiMock.sessions.announce.mockRejectedValue(new ApiError(409, 'Session has already been announced'));
    await openLinks();
    await userEvent.click(await screen.findByRole('button', { name: 'Send Fractions link to parents now' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Send now' }));
    expect(await screen.findByText('Session has already been announced')).toBeInTheDocument();
  });

  it('shows the announced badge and hides the send button', async () => {
    apiMock.sessions.list.mockResolvedValue([session({ announcedAt: `${today}T05:00:00Z` })]);
    await openLinks();
    expect(await screen.findByText(/Sent to parents/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /to parents now/ })).not.toBeInTheDocument();
  });

  it('validates the meeting link then creates a session with an IST offset', async () => {
    apiMock.sessions.create.mockResolvedValue(session());
    await openLinks();
    await userEvent.click(await screen.findByRole('button', { name: 'Add class link' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(/Date and time/), `${today}T16:30`);
    await userEvent.type(within(dialog).getByLabelText(/Meeting link/), 'http://insecure.example.test');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add class link' }));
    expect(await within(dialog).findByText('Meeting link must start with https://')).toBeInTheDocument();
    expect(apiMock.sessions.create).not.toHaveBeenCalled();

    const url = within(dialog).getByLabelText(/Meeting link/);
    await userEvent.clear(url);
    await userEvent.type(url, 'https://meet.example.test/ok');
    await userEvent.type(within(dialog).getByLabelText('Topic'), 'Algebra');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add class link' }));
    await waitFor(() =>
      expect(apiMock.sessions.create).toHaveBeenCalledWith({
        batchId: 'b1',
        startsAt: `${today}T16:30:00+05:30`,
        durationMinutes: 60,
        meetingUrl: 'https://meet.example.test/ok',
        topic: 'Algebra',
      }),
    );
    expect(await screen.findByText(/Class link added/)).toBeInTheDocument();
  });

  it("uses the batch's standing link when the link field is left empty", async () => {
    apiMock.academic.batches.mockResolvedValue([
      { ...batch, classLinkId: 'l1', classLink: { id: 'l1', name: '8th CBSE Science', meetingUrl: 'https://teams.example.test/standing', isActive: true }, schedules: [] },
    ]);
    apiMock.sessions.create.mockResolvedValue(session());
    await openLinks();
    await userEvent.click(await screen.findByRole('button', { name: 'Add class link' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/standing link: 8th CBSE Science/)).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText(/Date and time/), `${today}T16:30`);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add class link' }));
    await waitFor(() =>
      expect(apiMock.sessions.create).toHaveBeenCalledWith({ batchId: 'b1', startsAt: `${today}T16:30:00+05:30`, durationMinutes: 60 }),
    );
  });

  it('deletes after confirmation', async () => {
    apiMock.sessions.list.mockResolvedValue([session()]);
    apiMock.sessions.remove.mockResolvedValue(undefined);
    await openLinks();
    await userEvent.click(await screen.findByRole('button', { name: 'Delete Fractions link' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(apiMock.sessions.remove).toHaveBeenCalledWith('x1'));
    expect(await screen.findByText('Class link deleted')).toBeInTheDocument();
  });

  it('edits an existing session', async () => {
    apiMock.sessions.list.mockResolvedValue([session()]);
    apiMock.sessions.update.mockResolvedValue(session({ topic: 'Decimals' }));
    await openLinks();
    await userEvent.click(await screen.findByRole('button', { name: 'Edit Fractions link' }));
    const dialog = await screen.findByRole('dialog');
    const topic = within(dialog).getByLabelText('Topic');
    await userEvent.clear(topic);
    await userEvent.type(topic, 'Decimals');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(apiMock.sessions.update).toHaveBeenCalled());
    expect(apiMock.sessions.update.mock.calls[0][0]).toBe('x1');
    expect(apiMock.sessions.update.mock.calls[0][1]).toMatchObject({ topic: 'Decimals', startsAt: `${today}T10:00:00+05:30` });
  });
});

describe('Assessments tab', () => {
  async function openAssessments() {
    setup();
    await userEvent.click(await screen.findByRole('tab', { name: 'Assessments & marks' }));
  }

  it('renders the feed from real records with the subject analysis line', async () => {
    await openAssessments();
    const feed = await screen.findByRole('list', { name: 'Recent assessments' });
    expect(within(feed).getByText('Student One')).toBeInTheDocument();
    expect(within(feed).getByText('Maths')).toBeInTheDocument();
    expect(within(feed).getByText(/average 84%/)).toBeInTheDocument();
    expect(within(feed).getByText('“Solid work”')).toBeInTheDocument();
    expect(within(feed).getByText('42')).toBeInTheDocument();
  });

  it('omits the analysis line when no summary exists', async () => {
    apiMock.academic.summary.mockResolvedValue({ studentId: 's1', summary: null, message: 'No records found' });
    await openAssessments();
    await screen.findByRole('list', { name: 'Recent assessments' });
    expect(screen.queryByText(/average/)).not.toBeInTheDocument();
  });

  it('shows an empty state with no records', async () => {
    apiMock.academic.batchStudents.mockResolvedValue([{ ...students[1] }]);
    await openAssessments();
    expect(await screen.findByText('No assessments recorded yet')).toBeInTheDocument();
  });

  it('validates marks then posts the record', async () => {
    apiMock.academic.createRecord.mockResolvedValue({ ...students[0].academicRecords[0], id: 'r9' });
    await openAssessments();
    await userEvent.click(await screen.findByRole('button', { name: 'New assessment' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Search student'), 'two');
    await userEvent.selectOptions(within(dialog).getByLabelText(/^Student/, { selector: 'select' }), 's2');
    await userEvent.type(within(dialog).getByLabelText(/Subject/), 'Science');
    await userEvent.type(within(dialog).getByLabelText(/Marks obtained/), '60');
    await userEvent.type(within(dialog).getByLabelText(/Total marks/), '50');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save assessment' }));
    expect(await within(dialog).findByText('Marks obtained cannot exceed total marks')).toBeInTheDocument();
    expect(apiMock.academic.createRecord).not.toHaveBeenCalled();

    const obtained = within(dialog).getByLabelText(/Marks obtained/);
    await userEvent.clear(obtained);
    await userEvent.type(obtained, '45');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save assessment' }));
    await waitFor(() =>
      expect(apiMock.academic.createRecord).toHaveBeenCalledWith({
        studentId: 's2', subject: 'Science', markObtained: 45, totalMarks: 50, testDate: today,
      }),
    );
    expect(await screen.findByText(/Recorded/)).toBeInTheDocument();
  });

  it('hides New assessment without academics:manage', async () => {
    setup({ permissions: ['students:read', 'attendance:mark'] });
    await userEvent.click(await screen.findByRole('tab', { name: 'Assessments & marks' }));
    await screen.findByRole('list', { name: 'Recent assessments' });
    expect(screen.queryByRole('button', { name: 'New assessment' })).not.toBeInTheDocument();
  });
});
