import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../services/http';
import { renderWithProviders } from '../../test/renderWithProviders';
import type { Approval, DashboardOverview, FunnelAnalytics } from '../../types';
import OverviewView from './OverviewView';

const m = vi.hoisted(() => ({
  overview: vi.fn(),
  funnel: vi.fn(),
  status: vi.fn(),
  activityLog: vi.fn(),
  queue: vi.fn(),
  decide: vi.fn(),
  exceptions: vi.fn(),
  briefing: vi.fn(),
  runFollowup: vi.fn(),
  runDailyBriefing: vi.fn(),
  llm: vi.fn(),
}));

vi.mock('../../services/api', () => ({
  dashboard: { overview: m.overview, funnelAnalytics: m.funnel },
  agents: {
    status: m.status,
    activityLog: m.activityLog,
    approvalQueue: m.queue,
    decideApproval: m.decide,
    exceptions: m.exceptions,
    founderBriefing: m.briefing,
    runFollowup: m.runFollowup,
    runDailyBriefing: m.runDailyBriefing,
    runDemoReminders: vi.fn(),
    runAcademicMonitoring: vi.fn(),
    runProgressReports: vi.fn(),
  },
  dev: { llmMonitor: m.llm },
}));

const overview: DashboardOverview = {
  days: 30,
  timezone: 'Asia/Kolkata',
  since: '2026-09-17T00:00:00.000Z',
  leads: { total: 10, bySource: [{ source: 'Website', count: 6 }, { source: 'Unknown', count: 4 }], newLeadsPerDay: [] },
  demosThisWeek: 3,
  conversionRate: 12.5,
  activeStudents: 42,
  revenue: null,
  batches: [
    { batchId: 'b1', batch: 'Alpha', course: 'Maths', teacher: { id: 't1', name: 'T One' }, students: 5, avgScore: 80, attendance: 90, health: 'GREEN' },
    { batchId: 'b2', batch: 'Beta', course: 'Science', teacher: null, students: 9, avgScore: 40, attendance: 50, health: 'RED' },
  ],
  healthThresholds: { green: 75, yellow: 50 },
};

const funnel: FunnelAnalytics = {
  totalLeads: 10,
  stages: [
    { stage: 'enquiry', count: 2, reached: 10, conversionFromFirst: 100, dropOffFromPrevious: null },
    { stage: 'contacted', count: 4, reached: 8, conversionFromFirst: 80, dropOffFromPrevious: 20 },
    { stage: 'qualified', count: 1, reached: 4, conversionFromFirst: 40, dropOffFromPrevious: 50 },
  ],
  lost: { stage: 'lost', count: 2, shareOfAllLeads: 20 },
  overallConversionRate: 10,
};

function approval(over: Partial<Approval> = {}): Approval {
  return {
    id: 'ap1', agentId: 'AdmissionsAI', actionType: 'lead.mark_lost', title: 'Mark lead lost', reason: 'No reply', payload: {}, targetId: null,
    risk: 'medium', status: 'pending', decidedById: null, decidedAt: null, decisionNote: null, result: null, createdAt: '2026-10-01T00:00:00.000Z', ...over,
  };
}

beforeEach(() => {
  Object.values(m).forEach((f) => f.mockReset());
  m.overview.mockResolvedValue(overview);
  m.funnel.mockResolvedValue(funnel);
  m.status.mockResolvedValue([
    { agentId: 'AdmissionsAI', lastAction: new Date().toISOString(), actionsToday: 2 },
    { agentId: 'ReportingAnalyticsAI', lastAction: null, actionsToday: 0 },
  ]);
  m.activityLog.mockResolvedValue([
    { id: '1', agentId: 'AdmissionsAI', targetId: null, actionType: 'x', payload: null, status: 'success', timestamp: new Date().toISOString() },
    { id: '2', agentId: 'AdmissionsAI', targetId: null, actionType: 'y', payload: null, status: 'failure', timestamp: new Date().toISOString() },
  ]);
  m.queue.mockResolvedValue([]);
  m.exceptions.mockResolvedValue([]);
  m.briefing.mockResolvedValue({
    date: '2026-10-17',
    metrics: { totalLeads: 10, qualifiedLeads: 1, demosScheduled: 3, activeStudents: 42, healthDistribution: { green: 1, yellow: 0, red: 0 }, aiActionsToday: 2, exceptionsCount: 0 },
    briefingText: 'All quiet today.',
  });
  m.llm.mockResolvedValue({ status: 'success', metrics: { totalRequests: 0, byAgent: {}, byModel: {} } });
});

describe('OverviewView', () => {
  it('renders real KPIs, honest revenue empty state, funnel, sources and sortable batches', async () => {
    renderWithProviders(<OverviewView />, { user: { role: 'manager' } });
    expect(await screen.findByText('42')).toBeInTheDocument();
    expect(screen.getByText('No payments recorded yet')).toBeInTheDocument();
    expect(screen.getByText('12.5%')).toBeInTheDocument();
    expect(await screen.findByText(/Biggest leak: Contacted → Interested \(−50%\)/)).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Lead sources: Website 6, Unknown 4/ })).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Batch performance' });
    const names = () => within(table).getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[0].textContent);
    expect(names()).toEqual(['Alpha', 'Beta']);
    await userEvent.click(within(table).getByRole('button', { name: /Students/ }));
    await userEvent.click(within(table).getByRole('button', { name: /Students/ }));
    expect(names()).toEqual(['Beta', 'Alpha']);
    expect(screen.getByText('All quiet today.')).toBeInTheDocument();
  });

  it('formats revenue from the backend when payments exist', async () => {
    m.overview.mockResolvedValue({ ...overview, revenue: 125000 });
    renderWithProviders(<OverviewView />, { user: { role: 'manager' } });
    expect(await screen.findByText(/1,25,000/)).toBeInTheDocument();
  });

  it('shows an error with the server message and retries', async () => {
    m.overview.mockRejectedValueOnce(new ApiError(500, 'Overview exploded'));
    renderWithProviders(<OverviewView />, { user: { role: 'manager' } });
    expect(await screen.findByText('Overview exploded')).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole('button', { name: 'Retry' })[0]);
    expect(await screen.findByText('42')).toBeInTheDocument();
    expect(m.overview).toHaveBeenCalledTimes(2);
  });

  it('shows Queue clear and empty exceptions', async () => {
    renderWithProviders(<OverviewView />, { user: { role: 'manager' } });
    expect(await screen.findByText('Queue clear')).toBeInTheDocument();
    expect(await screen.findByText('No exceptions')).toBeInTheDocument();
  });

  it('lists pending approvals and the header chip count', async () => {
    m.queue.mockResolvedValue([approval()]);
    renderWithProviders(<OverviewView />, { user: { role: 'admin' } });
    expect(await screen.findByText('Mark lead lost')).toBeInTheDocument();
    expect(screen.getByText(/1 action needs your approval/)).toBeInTheDocument();
  });

  it('approves with a note, calls the endpoint and refreshes', async () => {
    m.queue.mockResolvedValueOnce([approval()]).mockResolvedValue([]);
    m.decide.mockResolvedValue({ status: 'executed', item: approval({ status: 'executed', result: { message: 'Lead marked lost' } }) });
    renderWithProviders(<OverviewView />, { user: { role: 'admin' } });
    await userEvent.click(await screen.findByRole('button', { name: 'Approve: Mark lead lost' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(/Note/), 'ok go');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Approve and run' }));
    await waitFor(() => expect(m.decide).toHaveBeenCalledWith('ap1', 'approved', 'ok go'));
    expect(await screen.findByText(/Approved: Mark lead lost\. Lead marked lost/)).toBeInTheDocument();
    await waitFor(() => expect(m.queue.mock.calls.length).toBeGreaterThan(1));
    expect(await screen.findByText('Queue clear')).toBeInTheDocument();
  });

  it('rejects without a note', async () => {
    m.queue.mockResolvedValue([approval()]);
    m.decide.mockResolvedValue({ status: 'rejected', item: approval({ status: 'rejected' }) });
    renderWithProviders(<OverviewView />, { user: { role: 'admin' } });
    await userEvent.click(await screen.findByRole('button', { name: 'Reject: Mark lead lost' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(m.decide).toHaveBeenCalledWith('ap1', 'rejected', undefined));
  });

  it('surfaces a server failure when the decision errors', async () => {
    m.queue.mockResolvedValue([approval()]);
    m.decide.mockRejectedValue(new ApiError(409, 'Already decided'));
    renderWithProviders(<OverviewView />, { user: { role: 'admin' } });
    await userEvent.click(await screen.findByRole('button', { name: 'Approve: Mark lead lost' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Approve and run' }));
    expect(await screen.findByText('Already decided')).toBeInTheDocument();
  });

  it('shows the failure of an executed-but-failed approval', async () => {
    m.queue.mockResolvedValue([approval()]);
    m.decide.mockResolvedValue({ status: 'failed', item: approval({ status: 'failed', result: { error: 'Lead not found' } }) });
    renderWithProviders(<OverviewView />, { user: { role: 'admin' } });
    await userEvent.click(await screen.findByRole('button', { name: 'Approve: Mark lead lost' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Approve and run' }));
    expect((await screen.findAllByText(/Lead not found/)).length).toBeGreaterThan(0);
  });

  it('disables high-risk decisions without approvals:decide_high_risk and explains why', async () => {
    m.queue.mockResolvedValue([approval({ risk: 'high', title: 'Refund' })]);
    renderWithProviders(<OverviewView />, { user: { role: 'admin' } });
    expect(await screen.findByRole('button', { name: 'Approve: Refund' })).toBeDisabled();
    expect(screen.getByText(/needs a user with the high-risk approval permission/)).toBeInTheDocument();
  });

  it('enables high-risk decisions with the permission', async () => {
    m.queue.mockResolvedValue([approval({ risk: 'high', title: 'Refund' })]);
    renderWithProviders(<OverviewView />, { user: { role: 'superadmin' } });
    expect(await screen.findByRole('button', { name: 'Approve: Refund' })).toBeEnabled();
  });

  it('hides decision buttons without approvals:decide', async () => {
    m.queue.mockResolvedValue([approval()]);
    renderWithProviders(<OverviewView />, { user: { role: 'manager' } });
    expect(await screen.findByText('Mark lead lost')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Approve:/ })).not.toBeInTheDocument();
  });

  it('shows Trigger only for agents with a real routine and agents:run, and toasts the real result', async () => {
    m.runFollowup.mockResolvedValue({ status: 'completed', result: { followedUpCount: 3, skippedOptedOut: 1, skippedRateLimited: 0 } });
    renderWithProviders(<OverviewView />, { user: { role: 'admin' } });
    const card = await screen.findByTestId('agent-AdmissionsAI');
    expect(within(screen.getByTestId('agent-ReportingAnalyticsAI')).queryByRole('button')).not.toBeInTheDocument();
    await userEvent.click(within(card).getByRole('button', { name: /Run follow-ups/ }));
    await waitFor(() => expect(m.runFollowup).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Follow-ups done: 3 leads contacted/)).toBeInTheDocument();
    expect(within(card).getByText('Succeeded (recent)').nextSibling).toHaveTextContent('1');
  });

  it('toasts the error when a routine fails', async () => {
    m.runFollowup.mockRejectedValue(new ApiError(500, 'Hermes down'));
    renderWithProviders(<OverviewView />, { user: { role: 'admin' } });
    await userEvent.click(within(await screen.findByTestId('agent-AdmissionsAI')).getByRole('button', { name: /Run follow-ups/ }));
    expect(await screen.findByText(/Hermes down/)).toBeInTheDocument();
  });

  it('hides Trigger without agents:run', async () => {
    renderWithProviders(<OverviewView />, { user: { role: 'manager' } });
    const card = await screen.findByTestId('agent-AdmissionsAI');
    expect(within(card).queryByRole('button')).not.toBeInTheDocument();
  });

  it('sends the briefing via the real endpoint', async () => {
    m.runDailyBriefing.mockResolvedValue({ status: 'completed', result: { success: true, preview: 'p' } });
    renderWithProviders(<OverviewView />, { user: { role: 'admin' } });
    await userEvent.click(await screen.findByRole('button', { name: 'Send briefing' }));
    await waitFor(() => expect(m.runDailyBriefing).toHaveBeenCalled());
    expect(await screen.findByText('Daily briefing sent to the founder.')).toBeInTheDocument();
  });

  it('token panel appears only with dev:console and shows real usage', async () => {
    m.llm.mockResolvedValue({
      status: 'success',
      metrics: { totalRequests: 5, successfulRequests: 5, failedRequests: 0, successRate: 100, totalTokens: 1234, promptTokens: 1000, completionTokens: 234, averageLatencyMs: 100, minLatencyMs: 1, maxLatencyMs: 2, tokensPerSecond: 1, byModel: { llama: { requests: 5, tokens: 1234, avgLatencyMs: 100 } }, byAgent: { AdmissionsAI: { requests: 5, tokens: 1234 } }, recentCalls: [] },
    });
    const { unmount } = renderWithProviders(<OverviewView />, { user: { role: 'admin' } });
    await screen.findByText('Queue clear');
    expect(screen.queryByText('AI Token Usage')).not.toBeInTheDocument();
    expect(m.llm).not.toHaveBeenCalled();
    unmount();
    renderWithProviders(<OverviewView />, { user: { role: 'superadmin' } });
    expect((await screen.findAllByText('1,234')).length).toBeGreaterThan(0);
  });

  it('skips dashboard sections without dashboard:view', async () => {
    renderWithProviders(<OverviewView />, { user: { role: 'teacher' }, permissions: ['agents:view'] });
    await screen.findByText('Queue clear');
    expect(m.overview).not.toHaveBeenCalled();
    expect(m.funnel).not.toHaveBeenCalled();
  });
});
