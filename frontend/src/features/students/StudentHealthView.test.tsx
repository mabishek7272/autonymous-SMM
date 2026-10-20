import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../test/renderWithProviders';
import { ApiError } from '../../services/http';
import type { Permission, StudentHealthEntry } from '../../types';
import StudentHealthView from './StudentHealthView';
import { deriveFlags } from './health';

const m = vi.hoisted(() => ({
  studentHealth: vi.fn(),
  batches: vi.fn(),
  scan: vi.fn(),
  enroll: vi.fn(),
  studentsList: vi.fn(),
  studentGet: vi.fn(),
  history: vi.fn(),
  parentGet: vi.fn(),
  sendToLead: vi.fn(),
}));

vi.mock('../../services/api', () => ({
  api: {
    dashboard: { studentHealth: m.studentHealth },
    academic: { batches: m.batches, enroll: m.enroll },
    agents: { runAcademicMonitoring: m.scan },
    students: { list: m.studentsList, get: m.studentGet },
    attendance: { studentHistory: m.history },
    parents: { get: m.parentGet },
    messages: { sendToLead: m.sendToLead },
  },
}));

function entry(over: Partial<StudentHealthEntry>): StudentHealthEntry {
  return {
    id: 's1',
    fullName: 'Student One',
    status: 'active',
    admissionDate: null,
    parent: { id: 'p1', fullName: 'Parent One' },
    health: 'GREEN',
    healthScore: 90,
    averagePercentage: 90,
    attendancePercentage: 95,
    attendanceWindowDays: 30,
    subjectAverages: [{ subject: 'Maths', averagePercentage: 90, testsCount: 2 }],
    lastAssessment: { subject: 'Maths', testDate: '2026-10-01T00:00:00.000Z', percentage: 90 },
    ...over,
  };
}

const DATA = [
  entry({}),
  entry({
    id: 's2',
    fullName: 'Student Two',
    health: 'RED',
    healthScore: 40,
    attendancePercentage: 40,
    subjectAverages: [{ subject: 'Science', averagePercentage: 30, testsCount: 1 }],
    lastAssessment: { subject: 'Science', testDate: null, percentage: 30 },
  }),
];

const BATCHES = [
  {
    id: 'b1',
    batchName: '10-A',
    course: { id: 'c1', courseName: 'Class 10' },
    enrollments: [{ id: 'e1', studentId: 's1', batchId: 'b1', enrollmentDate: '2026-01-01', student: { id: 's1', fullName: 'Student One', status: 'active' } }],
  },
];

const ADMIN: Permission[] = ['dashboard:view', 'students:read', 'students:manage', 'agents:run', 'leads:manage', 'attendance:mark'];

function setup(permissions: Permission[] = ADMIN) {
  return renderWithProviders(<StudentHealthView />, { permissions });
}

beforeEach(() => {
  vi.clearAllMocks();
  m.studentHealth.mockResolvedValue(DATA);
  m.batches.mockResolvedValue(BATCHES);
});

describe('StudentHealthView', () => {
  it('shows loading then real cards with live counts', async () => {
    setup();
    expect(screen.getByLabelText('Loading students')).toBeInTheDocument();
    expect(await screen.findByText('Student One')).toBeInTheDocument();
    expect(screen.getByText('Student Two')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Critical/ })).toHaveTextContent('1');
    expect(screen.getByText('Batch 10-A')).toBeInTheDocument();
  });

  it('shows error with server message and retries', async () => {
    m.studentHealth.mockRejectedValueOnce(new ApiError(500, 'Database down'));
    setup();
    expect(await screen.findByText('Database down')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByText('Student One')).toBeInTheDocument();
  });

  it('shows empty state when there are no students', async () => {
    m.studentHealth.mockResolvedValue([]);
    setup();
    expect(await screen.findByText('No active students yet')).toBeInTheDocument();
  });

  it('filters by health pill, search and batch', async () => {
    setup();
    await screen.findByText('Student One');
    await userEvent.click(screen.getByRole('button', { name: /^Critical/ }));
    expect(screen.queryByText('Student One')).not.toBeInTheDocument();
    expect(screen.getByText('Student Two')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^All/ }));
    await userEvent.type(screen.getByLabelText('Search students by name'), 'two');
    expect(screen.queryByText('Student One')).not.toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText('Search students by name'));
    await userEvent.selectOptions(screen.getByLabelText('Filter by batch'), 'b1');
    expect(screen.queryByText('Student Two')).not.toBeInTheDocument();
    expect(screen.getByText('Student One')).toBeInTheDocument();
  });

  it('derives flags only from real data', async () => {
    setup();
    await screen.findByText('Student Two');
    expect(screen.getByText(/Below 50% in Science/)).toBeInTheDocument();
    expect(screen.getByText(/Attendance 40%/)).toBeInTheDocument();
    expect(screen.getByText(/No flags/)).toBeInTheDocument();
    expect(deriveFlags(DATA[0])).toEqual([]);
  });

  it('runs the AI scan, toasts the real result and refetches', async () => {
    m.scan.mockResolvedValue({ status: 'completed', result: { totalScanned: 2, greenCount: 1, yellowCount: 0, redCount: 1, unknownCount: 0, diagnoses: [] } });
    setup();
    await screen.findByText('Student One');
    await userEvent.click(screen.getByRole('button', { name: /run ai scan/i }));
    expect(await screen.findByText(/Scan complete: 2 students/)).toBeInTheDocument();
    await waitFor(() => expect(m.studentHealth).toHaveBeenCalledTimes(2));
  });

  it('shows scan error toast', async () => {
    m.scan.mockRejectedValue(new ApiError(503, 'Ollama offline'));
    setup();
    await screen.findByText('Student One');
    await userEvent.click(screen.getByRole('button', { name: /run ai scan/i }));
    expect(await screen.findByText(/Ollama offline/)).toBeInTheDocument();
  });

  it('hides scan/enroll without permissions and disables messaging', async () => {
    setup(['dashboard:view', 'students:read']);
    await screen.findByText('Student One');
    expect(screen.queryByRole('button', { name: /run ai scan/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^enroll$/i })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /message parent of/i })[0]).toBeDisabled();
  });

  it('enrolls an existing student into a batch', async () => {
    m.studentsList.mockResolvedValue([
      { id: 's2', fullName: 'Student Two', status: 'active', parent: { id: 'p1', fullName: 'Parent One' } },
    ]);
    m.enroll.mockResolvedValue({ student: { fullName: 'Student Two' }, batch: { batchName: '10-A' } });
    setup();
    await screen.findByText('Student One');
    await userEvent.click(screen.getByRole('button', { name: /^enroll$/i }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.selectOptions(await within(dialog).findByLabelText(/Batch/), 'b1');
    await userEvent.selectOptions(within(dialog).getByLabelText(/Student/), 's2');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Enroll' }));
    await waitFor(() => expect(m.enroll).toHaveBeenCalledWith('b1', 's2'));
    expect(await screen.findByText(/Student Two enrolled in 10-A/)).toBeInTheDocument();
  });

  it('opens the profile with real detail and attendance', async () => {
    m.studentGet.mockResolvedValue({
      enrollments: [{ id: 'e1', enrollmentDate: '2026-01-01', batch: { batchName: '10-A', course: { courseName: 'Class 10' } } }],
      academicRecords: [{ id: 'r1', subject: 'Maths', testDate: '2026-10-01', markObtained: '45.00', totalMarks: '50.00' }],
    });
    m.history.mockResolvedValue({ markedDays: 2, presentDays: 1, percentage: 50, history: [{ id: 'a1', date: '2026-10-02', status: 'absent', batch: { id: 'b1', batchName: '10-A' } }] });
    setup();
    await screen.findByText('Student One');
    await userEvent.click(screen.getByRole('button', { name: 'View profile of Student One' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('45 / 50')).toBeInTheDocument();
    expect(await within(dialog).findByText(/1 of 2 marked days present/)).toBeInTheDocument();
    expect(m.studentGet).toHaveBeenCalledWith('s1', expect.anything());
  });

  it('messages the parent through their latest lead', async () => {
    m.parentGet.mockResolvedValue({ optedOut: false, leads: [{ id: 'l-old', updatedAt: '2026-01-01' }, { id: 'l-new', updatedAt: '2026-05-01' }] });
    m.sendToLead.mockResolvedValue({ status: 'queued', leadId: 'l-new' });
    setup();
    await screen.findByText('Student One');
    await userEvent.click(screen.getByRole('button', { name: 'Message parent of Student One' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(await within(dialog).findByLabelText(/Message/), 'Hello');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send WhatsApp' }));
    await waitFor(() => expect(m.sendToLead).toHaveBeenCalledWith('l-new', 'Hello'));
    expect(await screen.findByText(/Message queued/)).toBeInTheDocument();
  });

  it('explains when the parent has no lead to send through', async () => {
    m.parentGet.mockResolvedValue({ optedOut: false, leads: [] });
    setup();
    await screen.findByText('Student One');
    await userEvent.click(screen.getByRole('button', { name: 'Message parent of Student One' }));
    expect(await screen.findByText(/No enquiry is on file/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send WhatsApp' })).toBeDisabled();
  });
});
