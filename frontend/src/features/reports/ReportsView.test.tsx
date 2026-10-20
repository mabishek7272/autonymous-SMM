import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../test/renderWithProviders';
import { ApiError } from '../../services/http';
import type { ClassSessionWithBatch, ReminderRule, WeeklyReportListItem } from '../../types';

const mocks = vi.hoisted(() => ({
  reports: { list: vi.fn(), generate: vi.fn(), updateSummary: vi.fn(), approve: vi.fn(), bulkApprove: vi.fn(), send: vi.fn(), sendApproved: vi.fn() },
  reminders: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), runNow: vi.fn() },
  sessions: { today: vi.fn() },
  academic: { batches: vi.fn() },
}));
vi.mock('../../services/api', () => ({ api: mocks }));

import ReportsView from './ReportsView';

function report(over: Partial<WeeklyReportListItem> & { id: string; name: string }): WeeklyReportListItem {
  const { name, ...rest } = over;
  return {
    studentId: `s-${over.id}`,
    weekStart: '2026-10-12T00:00:00.000Z',
    summary: `Summary text for ${name}`,
    metrics: {
      weekStart: '2026-10-12',
      weekEnd: '2026-10-17',
      attendance: { markedDays: 5, attendedDays: 4, absentDays: 1, excusedDays: 0, percentage: 80, previousPercentage: null },
      marks: { assessments: 2, percentage: 72.4, previousPercentage: null, trend: null, trendDelta: null, subjects: [] },
      weakSubjects: ['Algebra'],
      summarySource: 'template',
    },
    status: 'draft',
    approvedById: null,
    approvedAt: null,
    sentAt: null,
    createdAt: '2026-10-17T00:00:00.000Z',
    student: { id: `s-${over.id}`, fullName: name, parent: { id: 'p1', fullName: `Parent of ${name}`, optedOut: false } },
    ...rest,
  };
}

const DRAFT = report({ id: 'r1', name: 'Student One' });
const APPROVED = report({ id: 'r2', name: 'Student Two', status: 'approved' });
const SENT = report({ id: 'r3', name: 'Student Three', status: 'sent' });
const OPTED_OUT = report({ id: 'r4', name: 'Student Four', status: 'approved', student: { id: 's4', fullName: 'Student Four', parent: { id: 'p4', fullName: 'Parent Four', optedOut: true } } });

const RULE: ReminderRule = {
  id: 'rule1',
  name: 'Monday nudge',
  audience: 'teacher',
  dayOfWeek: 1,
  timeOfDay: '09:00',
  template: 'Hi {{teacherName}}, mark {{batchNames}}',
  enabled: true,
  lastRunAt: null,
  createdById: null,
  createdAt: '2026-10-01T00:00:00.000Z',
};

const SESSION: ClassSessionWithBatch = {
  id: 'cs1',
  batchId: 'b1',
  topic: 'Fractions',
  startsAt: '2026-10-17T10:30:00.000Z',
  durationMinutes: 60,
  meetingUrl: 'https://meet.example.test/abc',
  notes: null,
  createdById: null,
  announcedAt: null,
  createdAt: '2026-10-16T00:00:00.000Z',
  batch: { id: 'b1', batchName: 'Batch Alpha' },
};

beforeEach(() => {
  vi.clearAllMocks();
  const all = [DRAFT, APPROVED, SENT, OPTED_OUT];
  mocks.reports.list.mockImplementation((params: { status?: string }) => Promise.resolve(params.status ? all.filter((r) => r.status === params.status) : all));
  mocks.reminders.list.mockResolvedValue([RULE]);
  mocks.sessions.today.mockResolvedValue([SESSION]);
  mocks.academic.batches.mockResolvedValue([{ id: 'b1', batchName: 'Batch Alpha' }]);
});

describe('ReportsView: weekly reports', () => {
  it('renders reports and real KPI counts', async () => {
    renderWithProviders(<ReportsView />);
    expect(await screen.findByText('Student One')).toBeInTheDocument();
    expect(screen.getByText('Student Two')).toBeInTheDocument();
    const kpis = screen.getByRole('region', { name: 'Key metrics' });
    expect(within(kpis).getByText('Drafts to review').nextElementSibling).toHaveTextContent('1');
    expect(within(kpis).getByText('Approved, unsent').nextElementSibling).toHaveTextContent('2');
    expect(within(kpis).getByText('Active reminders').nextElementSibling).toHaveTextContent('1');
    expect(screen.getAllByText('80%').length).toBeGreaterThan(0);
    expect(screen.getAllByText('72%').length).toBeGreaterThan(0);
  });

  it('shows a skeleton while loading', () => {
    mocks.reports.list.mockReturnValue(new Promise(() => undefined));
    renderWithProviders(<ReportsView />);
    expect(screen.queryByText('Student One')).not.toBeInTheDocument();
  });

  it('shows the server error and retries', async () => {
    mocks.reports.list.mockRejectedValueOnce(new ApiError(500, 'Database is down'));
    renderWithProviders(<ReportsView />);
    expect(await screen.findByText('Database is down')).toBeInTheDocument();
    mocks.reports.list.mockResolvedValue([DRAFT]);
    await userEvent.click(screen.getAllByRole('button', { name: /retry/i })[0] as HTMLElement);
    expect(await screen.findByText('Student One')).toBeInTheDocument();
  });

  it('shows an empty state and generates drafts for the selected week', async () => {
    mocks.reports.list.mockResolvedValue([]);
    mocks.reports.generate.mockResolvedValue({ weekStart: '2026-10-05', created: 3, regenerated: 0, keptExisting: 1, failed: [{ studentId: 'abcdef123456', error: 'No attendance data' }] });
    renderWithProviders(<ReportsView />);
    expect(await screen.findByText('No reports for this week')).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole('button', { name: 'Generate drafts' })[0] as HTMLElement);
    await waitFor(() => expect(mocks.reports.generate).toHaveBeenCalledTimes(1));
    const arg = mocks.reports.generate.mock.calls[0]?.[0] as { weekStart: string; batchId?: string };
    expect(arg.weekStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(arg.batchId).toBeUndefined();
    expect(await screen.findByText(/No attendance data/)).toBeInTheDocument();
    expect(screen.getAllByText(/Created 3, regenerated 0, kept 1 existing, 1 failed/).length).toBeGreaterThan(0);
  });

  it('passes the batch filter to the list and generate calls', async () => {
    mocks.reports.generate.mockResolvedValue({ weekStart: 'x', created: 0, regenerated: 0, keptExisting: 0, failed: [] });
    renderWithProviders(<ReportsView />);
    await screen.findByText('Student One');
    await userEvent.selectOptions(screen.getByLabelText('Batch'), 'b1');
    await waitFor(() => expect(mocks.reports.list).toHaveBeenCalledWith(expect.objectContaining({ batchId: 'b1' }), expect.anything()));
    await userEvent.click(screen.getByRole('button', { name: 'Generate drafts for this batch' }));
    await waitFor(() => expect(mocks.reports.generate).toHaveBeenCalledWith(expect.objectContaining({ batchId: 'b1' })));
  });

  it('filters by status', async () => {
    renderWithProviders(<ReportsView />);
    await screen.findByText('Student One');
    await userEvent.click(screen.getByRole('tab', { name: /^Sent/ }));
    expect(screen.queryByText('Student One')).not.toBeInTheDocument();
    expect(screen.getByText('Student Three')).toBeInTheDocument();
  });

  it('expands a row and edits a draft summary', async () => {
    mocks.reports.updateSummary.mockResolvedValue(DRAFT);
    renderWithProviders(<ReportsView />);
    await screen.findByText('Student One');
    await userEvent.click(screen.getByRole('button', { name: 'Edit summary for Student One' }));
    const box = screen.getByLabelText('Summary for Student One');
    await userEvent.clear(box);
    await userEvent.type(box, 'New words');
    await userEvent.click(screen.getByRole('button', { name: 'Save summary' }));
    await waitFor(() => expect(mocks.reports.updateSummary).toHaveBeenCalledWith('r1', 'New words'));
    expect(await screen.findByText('Summary saved')).toBeInTheDocument();
  });

  it('does not offer edit for non-draft rows but expands the full summary', async () => {
    renderWithProviders(<ReportsView />);
    await screen.findByText('Student Two');
    expect(screen.queryByRole('button', { name: 'Edit summary for Student Two' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Expand report for Student Two' }));
    expect(screen.getByText('Only drafts can be edited.')).toBeInTheDocument();
  });

  it('approves a single draft', async () => {
    mocks.reports.approve.mockResolvedValue({ ...DRAFT, status: 'approved' });
    renderWithProviders(<ReportsView />);
    await screen.findByText('Student One');
    await userEvent.click(screen.getByRole('button', { name: 'Approve report for Student One' }));
    await waitFor(() => expect(mocks.reports.approve).toHaveBeenCalledWith('r1'));
    expect(await screen.findByText('Approved report for Student One')).toBeInTheDocument();
  });

  it('bulk approves selected drafts and lists skipped reasons', async () => {
    mocks.reports.bulkApprove.mockResolvedValue({ approved: [], skipped: [{ id: 'r1', reason: 'Not a draft' }] });
    renderWithProviders(<ReportsView />);
    await screen.findByText('Student One');
    expect(screen.getByRole('button', { name: /Approve selected \(0\)/ })).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select report for Student One' }));
    await userEvent.click(screen.getByRole('button', { name: 'Approve selected (1)' }));
    await waitFor(() => expect(mocks.reports.bulkApprove).toHaveBeenCalledWith(['r1']));
    expect(await screen.findByText(/Not a draft/)).toBeInTheDocument();
  });

  it('confirms before sending a single report', async () => {
    mocks.reports.send.mockResolvedValue({ outcome: { reportId: 'r2', outcome: 'sent' }, report: null });
    renderWithProviders(<ReportsView />);
    await screen.findByText('Student Two');
    await userEvent.click(screen.getByRole('button', { name: 'Send report for Student Two' }));
    expect(mocks.reports.send).not.toHaveBeenCalled();
    await userEvent.click(await screen.findByRole('button', { name: 'Send report' }));
    await waitFor(() => expect(mocks.reports.send).toHaveBeenCalledWith('r2'));
    expect(await screen.findByText(/Report for Student Two sent/)).toBeInTheDocument();
  });

  it('shows the server error when a send fails', async () => {
    mocks.reports.send.mockRejectedValue(new ApiError(502, 'Sending failed: gateway down'));
    renderWithProviders(<ReportsView />);
    await screen.findByText('Student Two');
    await userEvent.click(screen.getByRole('button', { name: 'Send report for Student Two' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Send report' }));
    expect(await screen.findByText(/Sending failed: gateway down/)).toBeInTheDocument();
  });

  it('disables send for opted-out parents', async () => {
    renderWithProviders(<ReportsView />);
    await screen.findByText('Student Four');
    expect(screen.getByRole('button', { name: 'Send report for Student Four' })).toBeDisabled();
  });

  it('sends all approved after confirmation and shows skipped and failed reasons', async () => {
    mocks.reports.sendApproved.mockResolvedValue({
      sent: 1,
      skipped: [{ reportId: 'r4', outcome: 'skipped', reason: 'WhatsApp consent withdrawn' }],
      failed: [{ reportId: 'r2', outcome: 'failed', reason: 'Gateway timeout' }],
    });
    renderWithProviders(<ReportsView />);
    await screen.findByText('Student One');
    const sendAll = await screen.findByRole('button', { name: 'Send all approved (2)' });
    await userEvent.click(sendAll);
    expect(mocks.reports.sendApproved).not.toHaveBeenCalled();
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Send all approved' }));
    await waitFor(() => expect(mocks.reports.sendApproved).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/WhatsApp consent withdrawn/)).toBeInTheDocument();
    expect(screen.getByText(/Gateway timeout/)).toBeInTheDocument();
  });
});

describe('ReportsView: reminders', () => {
  it('shows the empty state and creates the default Monday 9:00 reminder', async () => {
    mocks.reminders.list.mockResolvedValue([]);
    mocks.reminders.create.mockResolvedValue(RULE);
    renderWithProviders(<ReportsView />);
    await userEvent.click(await screen.findByRole('button', { name: 'Create the default Monday 9:00 reminder' }));
    await waitFor(() => expect(mocks.reminders.create).toHaveBeenCalledTimes(1));
    expect(mocks.reminders.create).toHaveBeenCalledWith(expect.objectContaining({ dayOfWeek: 1, timeOfDay: '09:00', audience: 'teacher', template: expect.stringContaining('{{teacherName}}') }));
  });

  it('shows an error with retry', async () => {
    mocks.reminders.list.mockRejectedValueOnce(new ApiError(500, 'Rules unavailable'));
    renderWithProviders(<ReportsView />);
    expect(await screen.findByText('Rules unavailable')).toBeInTheDocument();
    mocks.reminders.list.mockResolvedValue([RULE]);
    const retry = screen.getAllByRole('button', { name: /retry/i }).at(-1) as HTMLElement;
    await userEvent.click(retry);
    expect(await screen.findByText('Monday nudge')).toBeInTheDocument();
  });

  it('lists rules with day, time and placeholders', async () => {
    renderWithProviders(<ReportsView />);
    expect(await screen.findByText('Monday nudge')).toBeInTheDocument();
    expect(screen.getByText(/Monday at 09:00 IST/)).toBeInTheDocument();
    expect(screen.getAllByText('{{pendingAttendanceDays}}').length).toBeGreaterThan(0);
  });

  it('toggles a rule via PATCH', async () => {
    mocks.reminders.update.mockResolvedValue({ ...RULE, enabled: false });
    renderWithProviders(<ReportsView />);
    await userEvent.click(await screen.findByRole('switch', { name: 'Enabled: Monday nudge' }));
    await waitFor(() => expect(mocks.reminders.update).toHaveBeenCalledWith('rule1', { enabled: false }));
    expect(await screen.findByText('"Monday nudge" disabled')).toBeInTheDocument();
  });

  it('runs a rule now and reports skipped teachers honestly', async () => {
    mocks.reminders.runNow.mockResolvedValue({
      ruleId: 'rule1', ruleName: 'Monday nudge', audience: 'teacher', sent: 2,
      skipped: [{ teacherId: 't1', name: 'Teacher X', reason: 'No phone number' }], failed: [],
    });
    renderWithProviders(<ReportsView />);
    await userEvent.click(await screen.findByRole('button', { name: 'Run Monday nudge now' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Run now' }));
    await waitFor(() => expect(mocks.reminders.runNow).toHaveBeenCalledWith('rule1'));
    expect(await screen.findByText(/No phone number/)).toBeInTheDocument();
    expect(screen.getAllByText(/Sent 2, skipped 1, failed 0/).length).toBeGreaterThan(0);
  });

  it('deletes a rule after confirmation', async () => {
    mocks.reminders.remove.mockResolvedValue(undefined);
    renderWithProviders(<ReportsView />);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete Monday nudge' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete reminder' }));
    await waitFor(() => expect(mocks.reminders.remove).toHaveBeenCalledWith('rule1'));
  });

  it('validates the form and creates a rule', async () => {
    mocks.reminders.create.mockResolvedValue(RULE);
    renderWithProviders(<ReportsView />);
    await userEvent.click(await screen.findByRole('button', { name: 'New reminder' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create reminder' }));
    expect(mocks.reminders.create).not.toHaveBeenCalled();
    expect(within(dialog).getByText('Name is required')).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText(/^Name/), 'Friday');
    await userEvent.click(within(dialog).getByLabelText(/^Message template/));
    await userEvent.paste('Hello {{bogus}}');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create reminder' }));
    expect(within(dialog).getByText(/Unknown placeholder\(s\): \{\{bogus\}\}/)).toBeInTheDocument();
    await userEvent.clear(within(dialog).getByLabelText(/^Message template/));
    await userEvent.click(within(dialog).getByLabelText(/^Message template/));
    await userEvent.paste('Hi {{teacherName}}');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create reminder' }));
    await waitFor(() => expect(mocks.reminders.create).toHaveBeenCalledWith({ name: 'Friday', audience: 'teacher', dayOfWeek: 1, timeOfDay: '09:00', template: 'Hi {{teacherName}}' }));
  });

  it('closes the modal on Escape', async () => {
    renderWithProviders(<ReportsView />);
    await userEvent.click(await screen.findByRole('button', { name: 'New reminder' }));
    await screen.findByRole('dialog');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});

describe('ReportsView: today sessions and permissions', () => {
  it('lists today sessions with announced status', async () => {
    renderWithProviders(<ReportsView />);
    expect(await screen.findByText('Not announced')).toBeInTheDocument();
    expect(screen.getByText('Fractions')).toBeInTheDocument();
    expect(screen.getByText('Not announced')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open meeting link for Batch Alpha' })).toHaveAttribute('href', 'https://meet.example.test/abc');
  });

  it('shows an empty state when there are no classes today', async () => {
    mocks.sessions.today.mockResolvedValue([]);
    renderWithProviders(<ReportsView />);
    expect(await screen.findByText('No classes scheduled today')).toBeInTheDocument();
  });

  it('shows an error with retry for sessions', async () => {
    mocks.sessions.today.mockRejectedValueOnce(new ApiError(500, 'Sessions broke'));
    renderWithProviders(<ReportsView />);
    expect(await screen.findByText('Sessions broke')).toBeInTheDocument();
  });

  it('hides sections the user has no permission for', async () => {
    renderWithProviders(<ReportsView />, { permissions: ['sessions:manage'] });
    expect(await screen.findByText('Fractions')).toBeInTheDocument();
    expect(screen.queryByText('Weekly student reports')).not.toBeInTheDocument();
    expect(screen.queryByText('Weekly teacher reminders')).not.toBeInTheDocument();
    expect(mocks.reports.list).not.toHaveBeenCalled();
    expect(mocks.reminders.list).not.toHaveBeenCalled();
  });

  it('shows no access with no relevant permission', () => {
    renderWithProviders(<ReportsView />, { permissions: [] });
    expect(screen.getByText('No access')).toBeInTheDocument();
  });
});
