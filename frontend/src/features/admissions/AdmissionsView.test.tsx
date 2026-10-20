import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../test/renderWithProviders';
import type { LeadWithParent } from '../../types';
import AdmissionsView from './AdmissionsView';

const m = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  updateStatus: vi.fn(),
  kpis: vi.fn(),
  history: vi.fn(),
  sendToLead: vi.fn(),
  checkCalendar: vi.fn(),
  book: vi.fn(),
  batches: vi.fn(),
  onboardLead: vi.fn(),
  importRows: vi.fn(),
}));

vi.mock('../../services/api', async (orig) => ({
  ...(await orig<typeof import('../../services/api')>()),
  leads: { list: m.list, get: m.get, create: m.create, updateStatus: m.updateStatus, importRows: m.importRows },
  dashboard: { kpis: m.kpis },
  messages: { history: m.history, sendToLead: m.sendToLead },
  appointments: { checkCalendar: m.checkCalendar, book: m.book },
  academic: { batches: m.batches },
  students: { onboardLead: m.onboardLead },
}));

function lead(over: Partial<LeadWithParent> & { id: string; name: string }): LeadWithParent {
  const { name, ...rest } = over;
  return {
    parentId: `p-${over.id}`,
    source: null,
    status: 'enquiry',
    gradeInterested: null,
    boardInterested: null,
    subjectsInterested: [],
    requirements: null,
    assignedAgentId: null,
    aiScore: null,
    timeline: null,
    notes: null,
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
    parent: {
      id: `p-${over.id}`,
      fullName: name,
      whatsappNumber: '+910000000001',
      email: null,
      address: null,
      optedOut: false,
      optedOutAt: null,
      createdAt: '2026-10-01T10:00:00.000Z',
    },
    appointments: [],
    ...rest,
  };
}

const page = (data: LeadWithParent[]) => ({ data, meta: { total: data.length, page: 1, limit: 100, totalPages: 1 } });
const A = lead({ id: 'a', name: 'Alpha Parent', aiScore: 82, source: 'Meta', gradeInterested: 'Class 9', notes: 'wants maths' });
const B = lead({ id: 'b', name: 'Beta Parent', status: 'qualified' });

beforeEach(() => {
  Object.values(m).forEach((f) => f.mockReset());
  m.list.mockResolvedValue(page([A, B]));
  m.get.mockImplementation((id: string) => Promise.resolve(id === 'a' ? A : B));
  m.kpis.mockResolvedValue({ totalLeads: 2, convertedLeads: 0, conversionRate: '0%', activeStudents: 5, demoScheduled: 0, aiActionsToday: 3, leadsByStage: {} });
  m.history.mockResolvedValue({ data: [], page: 1, pageSize: 100, total: 0, totalPages: 0 });
  m.batches.mockResolvedValue([]);
});

describe('AdmissionsView', () => {
  it('shows a loading state, then the leads in their stage columns', async () => {
    renderWithProviders(<AdmissionsView />);
    expect(screen.getByRole('status', { name: 'Loading leads' })).toBeInTheDocument();
    const newCol = await screen.findByRole('region', { name: 'New column' });
    expect(within(newCol).getByText('Alpha Parent')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Interested column' })).getByText('Beta Parent')).toBeInTheDocument();
    expect(await screen.findByText('Active students')).toBeInTheDocument();
  });

  it('shows the AI score only when the lead has one', async () => {
    renderWithProviders(<AdmissionsView />);
    await screen.findByText('Alpha Parent');
    expect(screen.getAllByLabelText(/^AI score/)).toHaveLength(1);
    expect(screen.getByLabelText('AI score 82')).toBeInTheDocument();
  });

  it('renders the server error with a working Retry', async () => {
    m.list.mockRejectedValueOnce(new Error('Database is down'));
    renderWithProviders(<AdmissionsView />);
    expect(await screen.findByText('Database is down')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByText('Alpha Parent')).toBeInTheDocument();
  });

  it('shows an empty state when there are no leads', async () => {
    m.list.mockResolvedValue(page([]));
    renderWithProviders(<AdmissionsView />);
    expect(await screen.findByText('No leads yet')).toBeInTheDocument();
  });

  it('search sends the query to the server', async () => {
    renderWithProviders(<AdmissionsView />);
    await screen.findByText('Alpha Parent');
    m.list.mockResolvedValue(page([A]));
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search leads' }), 'alp');
    await waitFor(() => expect(m.list).toHaveBeenCalledWith(expect.objectContaining({ q: 'alp' }), expect.anything()));
    await waitFor(() => expect(screen.queryByText('Beta Parent')).not.toBeInTheDocument());
  });

  it('Move calls PATCH status and reports success', async () => {
    m.updateStatus.mockResolvedValue({ ...A, status: 'contacted' });
    renderWithProviders(<AdmissionsView />);
    await userEvent.click(await screen.findByRole('button', { name: 'Move Alpha Parent to Contacted' }));
    await waitFor(() => expect(m.updateStatus).toHaveBeenCalledWith('a', 'contacted'));
    expect(await screen.findByText('Alpha Parent moved to Contacted')).toBeInTheDocument();
  });

  it('rolls the card back and shows the server message when the move fails', async () => {
    m.updateStatus.mockRejectedValue(new Error('Lead not found'));
    renderWithProviders(<AdmissionsView />);
    await userEvent.click(await screen.findByRole('button', { name: 'Move Alpha Parent to Contacted' }));
    expect(await screen.findByText(/Lead not found/)).toBeInTheDocument();
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'New column' })).getByText('Alpha Parent')).toBeInTheDocument());
  });

  it('marking lost without approval rights says it was sent for approval and keeps the card', async () => {
    m.updateStatus.mockResolvedValue({ pendingApproval: true, approvalId: 'x', message: 'needs approval' });
    renderWithProviders(<AdmissionsView />);
    await userEvent.click(await screen.findByRole('button', { name: 'View Alpha Parent' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Mark Lost' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Mark lost' }));
    await waitFor(() => expect(m.updateStatus).toHaveBeenCalledWith('a', 'lost'));
    expect(await screen.findByText(/Sent for approval/)).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'New column' })).getByText('Alpha Parent')).toBeInTheDocument();
  });

  it('lead modal shows the real WhatsApp history and sends a message', async () => {
    m.history.mockResolvedValue({
      data: [{ id: 'm1', direction: 'inbound', channel: 'whatsapp', body: 'Hello there', createdAt: '2026-10-02T10:00:00.000Z', agentId: null }],
      page: 1, pageSize: 100, total: 1, totalPages: 1,
    });
    m.sendToLead.mockResolvedValue({ status: 'queued', leadId: 'a' });
    renderWithProviders(<AdmissionsView />);
    await userEvent.click(await screen.findByRole('button', { name: 'Message Alpha Parent' }));
    expect(await screen.findByText('Hello there')).toBeInTheDocument();
    expect(screen.getByText(/Parent replied/)).toBeInTheDocument();
    const box = screen.getByLabelText('Send a WhatsApp message');
    await userEvent.type(box, 'Hi, shall we book a demo?');
    await userEvent.click(screen.getByRole('button', { name: 'Send Message' }));
    await waitFor(() => expect(m.sendToLead).toHaveBeenCalledWith('a', 'Hi, shall we book a demo?'));
    expect(await screen.findByText(/Message queued for WhatsApp/)).toBeInTheDocument();
  });

  it('shows the server error when sending fails', async () => {
    m.sendToLead.mockRejectedValue(new Error('Parent has opted out of WhatsApp messages'));
    renderWithProviders(<AdmissionsView />);
    await userEvent.click(await screen.findByRole('button', { name: 'Message Alpha Parent' }));
    await userEvent.type(await screen.findByLabelText('Send a WhatsApp message'), 'hi');
    await userEvent.click(screen.getByRole('button', { name: 'Send Message' }));
    expect(await screen.findByText(/opted out of WhatsApp/)).toBeInTheDocument();
  });

  it('adds a lead through POST /leads', async () => {
    m.create.mockResolvedValue(lead({ id: 'c', name: 'Gamma Parent' }));
    renderWithProviders(<AdmissionsView />);
    await screen.findByText('Alpha Parent');
    await userEvent.click(screen.getByRole('button', { name: 'Add Lead' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(/Parent name/), 'Gamma Parent');
    await userEvent.type(within(dialog).getByLabelText(/WhatsApp number/), '+919999999999');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Maths' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add Lead' }));
    await waitFor(() =>
      expect(m.create).toHaveBeenCalledWith({ parentName: 'Gamma Parent', whatsappNumber: '+919999999999', subjectsInterested: ['Maths'] }),
    );
    expect(await screen.findByText('Lead added: Gamma Parent')).toBeInTheDocument();
  });

  it('books a demo from the real available slots', async () => {
    m.checkCalendar.mockResolvedValue({
      date: '2026-10-20', timezone: 'Asia/Kolkata', bookedCount: 0, bookedAppointments: [],
      availableSlots: [{ time: '10:00', iso: '2026-10-20T04:30:00.000Z', formatted: '10:00 IST', available: true }],
    });
    m.book.mockResolvedValue({ id: 'ap', leadId: 'a', scheduledAt: '2026-10-20T04:30:00.000Z', durationMinutes: 30, status: 'scheduled', feedback: null, createdAt: '' });
    renderWithProviders(<AdmissionsView />);
    await userEvent.click(await screen.findByRole('button', { name: 'View Alpha Parent' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Book Demo' }));
    await userEvent.click(await screen.findByRole('button', { name: '10:00 IST' }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm booking' }));
    await waitFor(() => expect(m.book).toHaveBeenCalledWith({ leadId: 'a', scheduledAt: '2026-10-20T04:30:00.000Z' }));
    expect(await screen.findByText(/Demo booked for Alpha Parent/)).toBeInTheDocument();
  });

  it('enrolls an admitted lead and surfaces a duplicate payment reference error', async () => {
    m.batches.mockResolvedValue([{ id: 'b1', batchName: 'Evening', course: { courseName: 'Maths 9' } }]);
    m.onboardLead.mockRejectedValueOnce(new Error('paymentReference has already been recorded'));
    m.onboardLead.mockResolvedValueOnce({ student: { fullName: 'Kid One' }, enrollment: null, payment: {}, welcomeMessage: 'queued' });
    renderWithProviders(<AdmissionsView />);
    await screen.findByText('Beta Parent');
    await userEvent.click(screen.getByRole('button', { name: 'Enroll Student' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByText('Alpha Parent')).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: /Beta Parent/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Next' }));
    await userEvent.type(within(dialog).getByLabelText(/Student name/), 'Kid One');
    await userEvent.selectOptions(within(dialog).getByLabelText('Batch'), 'b1');
    await userEvent.type(within(dialog).getByLabelText(/Payment reference/), 'REF123');
    await userEvent.type(within(dialog).getByLabelText(/Amount paid/), '5000');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Next' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Confirm enrollment' }));
    expect(await within(dialog).findAllByText(/already been recorded/)).not.toHaveLength(0);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Next' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Confirm enrollment' }));
    await waitFor(() =>
      expect(m.onboardLead).toHaveBeenLastCalledWith({ leadId: 'b', studentName: 'Kid One', batchId: 'b1', paymentReference: 'REF123', amountPaid: 5000, paymentMode: 'UPI' }),
    );
    expect(await screen.findByText(/Kid One admitted/)).toBeInTheDocument();
  });

  it('gates by permission: no leads:manage means no board, no students:manage hides Enroll', async () => {
    const { unmount } = renderWithProviders(<AdmissionsView />, { permissions: ['dashboard:view'] });
    expect(screen.getByText('No access to admissions')).toBeInTheDocument();
    expect(m.list).not.toHaveBeenCalled();
    unmount();
    renderWithProviders(<AdmissionsView />, { permissions: ['leads:manage'] });
    await screen.findByText('Alpha Parent');
    expect(screen.queryByRole('button', { name: 'Enroll Student' })).not.toBeInTheDocument();
    expect(m.kpis).not.toHaveBeenCalled();
  });
});

describe('AdmissionsView — import enquiry sheet', () => {
  it('previews with a dry run, then imports the pasted rows', async () => {
    m.importRows.mockImplementation(async (_rows: unknown, dryRun: boolean) => ({
      dryRun, created: 2, skippedDuplicates: 1, newParents: 2, byStatus: { follow_up: 1, demo_scheduled: 1 }, invalid: [],
    }));
    renderWithProviders(<AdmissionsView />);
    await userEvent.click(await screen.findByRole('button', { name: 'Import leads' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByLabelText('Rows'));
    await userEvent.paste('Chithraa\t10\tCBSE\t7299989912\tWithin 1 Week\tCall again on Wednesday\nSelvam\t10\tCBSE\t9500956566\tWhen Program Starts\tDemo at 7:30 PM');
    expect(await within(dialog).findByText(/2 new leads/)).toBeInTheDocument();
    expect(within(dialog).getByText(/1 → Follow-up/)).toBeInTheDocument();
    expect(m.importRows).toHaveBeenLastCalledWith(
      [
        { name: 'Chithraa', grade: '10', board: 'CBSE', phone: '7299989912', timeline: 'Within 1 Week', notes: 'Call again on Wednesday', remarks: undefined },
        { name: 'Selvam', grade: '10', board: 'CBSE', phone: '9500956566', timeline: 'When Program Starts', notes: 'Demo at 7:30 PM', remarks: undefined },
      ],
      true,
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Import 2 leads' }));
    await waitFor(() => expect(m.importRows).toHaveBeenLastCalledWith(expect.any(Array), false));
    expect(await screen.findByText(/Imported 2 leads/)).toBeInTheDocument();
  });

  it('shows rows the server cannot use and does not offer to import nothing', async () => {
    m.importRows.mockResolvedValue({ dryRun: true, created: 0, skippedDuplicates: 0, newParents: 0, byStatus: {}, invalid: [{ row: 1, message: '"Nophone": no valid phone number' }] });
    renderWithProviders(<AdmissionsView />);
    await userEvent.click(await screen.findByRole('button', { name: 'Import leads' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByLabelText('Rows'));
    await userEvent.paste('Nophone\t12\tCBSE\t12345678');
    expect(await within(dialog).findByText(/no valid phone number/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Import' })).toBeDisabled();
  });
});
