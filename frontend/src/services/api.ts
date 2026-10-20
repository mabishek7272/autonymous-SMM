/**
 * Typed client for every backend endpoint the UI uses. Each method maps 1:1 to a route in
 * backend/src/routes/*.ts and resolves with the server's response or throws ApiError.
 * There is deliberately no fallback data anywhere in this file.
 */
import type {
  BatchSchedule,
  ClassLinkWithUsage,
  AcademicAnalytics,
  AcademicRecord,
  AcademicScanResult,
  AcademicSummary,
  AgentStatus,
  AiActivityLog,
  AnnounceResult,
  Appointment,
  AppointmentStatus,
  AppointmentWithLead,
  Approval,
  ApprovalDecisionResponse,
  ApprovalStatus,
  AttendanceBatchSummary,
  AttendanceMarkEntry,
  AttendanceMarkResult,
  AttendanceRoster,
  Batch,
  BatchDetail,
  BatchRosterStudent,
  BatchWithCourse,
  BriefingDispatchResult,
  BulkApproveResult,
  CallLog,
  CallLogList,
  ClassSessionWithBatch,
  ClearCacheResult,
  Course,
  CourseWithBatches,
  DashboardKpis,
  DashboardOverview,
  DemoReminderResult,
  DevConfigResponse,
  DevConfigUpdate,
  Enrollment,
  ExceptionItem,
  FollowupResult,
  FounderBriefing,
  FunnelAnalytics,
  GenerateReportsResult,
  Lead,
  LeadPipeline,
  LeadSource,
  LeadStatus,
  LeadWithParent,
  LlmMonitorResponse,
  LoginOtpChallenge,
  LoginResponse,
  MessageHistory,
  OllamaModelsResponse,
  OllamaPrompt,
  OllamaTestResult,
  OnboardResult,
  Paginated,
  Parent,
  ParentDetail,
  ParentListItem,
  PendingApprovalResponse,
  ProgressReportsResult,
  ReminderRule,
  ReminderRuleInput,
  RoutineResponse,
  RuleRunResult,
  SendApprovedResult,
  SendOutcome,
  SessionUser,
  Student,
  VoiceStatus,
  StudentAttendanceHistory,
  StudentDetail,
  StudentHealthEntry,
  StudentListItem,
  StudentProgressReportResult,
  StatusMessage,
  User,
  WeeklyReport,
  WeeklyReportDetail,
  WeeklyReportListItem,
  WhatsAppSimulateHistoryItem,
  WhatsAppSimulateResult,
  WhatsAppStatus,
  ReportStatus,
  Role,
} from '../types';
import { request, requestText } from './http';
import { streamOllama } from './stream';

type Signal = { signal?: AbortSignal };

const get = <T>(path: string, query?: Record<string, string | number | boolean | null | undefined>, opts?: Signal) =>
  request<T>(path, { query, signal: opts?.signal });
const send = <T>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown) =>
  request<T>(path, { method, body });

// ── auth ─────────────────────────────────────────────────────

export const auth = {
  /** Step 1: email + password. Never returns a session; emails a code and returns a challenge for step 2. */
  login: (email: string, password: string) => send<LoginOtpChallenge>('POST', '/auth/login', { email, password }),
  /** Step 2: redeem the emailed 6-digit code for a real session. */
  verifyOtp: (otpToken: string, code: string) => send<LoginResponse>('POST', '/auth/verify-otp', { otpToken, code }),
  /** Invalidates the current code and emails (or dev-generates) a fresh one for the same pending login. */
  resendOtp: (otpToken: string) => send<LoginOtpChallenge>('POST', '/auth/resend-otp', { otpToken }),
  me: (opts?: Signal) => get<SessionUser>('/auth/me', undefined, opts),
  changePassword: (currentPassword: string, newPassword: string) =>
    send<void>('POST', '/auth/change-password', { currentPassword, newPassword }),
};

// ── users (users:manage) ─────────────────────────────────────

export interface CreateUserInput {
  fullName: string;
  email: string;
  password: string;
  role: Role;
  /** digits only, with country code (10-15 digits) */
  phone?: string;
  /** faculty code used on the timetable, e.g. BPY */
  initials?: string;
}

export interface UpdateUserInput {
  fullName?: string;
  role?: Role;
  phone?: string | null;
  initials?: string | null;
  isActive?: boolean;
  password?: string;
}

export interface RowProblem {
  /** 1-based position in the pasted/uploaded rows */
  row: number;
  message: string;
}

export interface TeacherImportRow {
  fullName: string;
  email: string;
  phone: string;
  initials?: string;
  /** batch names separated by ';' */
  batches?: string;
  /** optional; a random password is generated when omitted */
  password?: string;
}

export interface TeacherImportResult {
  dryRun: boolean;
  created: number;
  existing: number;
  batchesAssigned: number;
  invalid: RowProblem[];
  warnings: RowProblem[];
  /** Generated passwords of the accounts just created. Returned once only. */
  credentials: { email: string; fullName: string; password: string }[];
  /** How many new teachers were emailed their login details */
  emailed: number;
}

export interface StudentImportRow {
  studentName: string;
  parentName?: string;
  parentPhone: string;
  parentEmail?: string;
  grade?: string;
  board?: string;
  dateOfBirth?: string;
  admissionDate?: string;
  /** batch names (class + subject) separated by ';' */
  batches?: string;
}

export interface StudentImportResult {
  dryRun: boolean;
  created: number;
  existing: number;
  newParents: number;
  enrollmentsAdded: number;
  invalid: RowProblem[];
  warnings: RowProblem[];
  studentIds: string[];
}

export const users = {
  list: (opts?: Signal) => get<{ data: User[] }>('/users', undefined, opts),
  create: (input: CreateUserInput) => send<User>('POST', '/users', input),
  update: (id: string, input: UpdateUserInput) => send<User>('PATCH', `/users/${id}`, input),
  /** users:manage. Bulk-creates teacher accounts; dryRun previews. Generated passwords come back once in `credentials`. */
  importTeachers: (rows: TeacherImportRow[], dryRun = false) =>
    send<TeacherImportResult>('POST', '/users/import', { rows, dryRun }),
};

// ── leads (leads:manage) ─────────────────────────────────────

export interface LeadListParams {
  status?: LeadStatus;
  /** matches parent name or whatsapp number */
  q?: string;
  page?: number;
  /** 1-100, backend default 20 */
  limit?: number;
}

export interface CreateLeadInput {
  parentId?: string;
  /** required together with whatsappNumber when parentId is absent */
  parentName?: string;
  whatsappNumber?: string;
  source?: LeadSource;
  gradeInterested?: string;
  boardInterested?: string;
  subjectsInterested?: string[];
  requirements?: string;
  notes?: string;
}

export interface QualifyLeadInput {
  gradeInterested: string;
  boardInterested: string;
  subjectsInterested: string[];
  requirements?: string;
  notes?: string;
  aiScore?: number;
  agentId?: string;
}

export function isPendingApproval(value: unknown): value is PendingApprovalResponse {
  return typeof value === 'object' && value !== null && (value as { pendingApproval?: unknown }).pendingApproval === true;
}

export const leads = {
  list: (params: LeadListParams = {}, opts?: Signal) =>
    get<Paginated<LeadWithParent>>('/leads', { ...params }, opts),
  get: (id: string, opts?: Signal) => get<LeadWithParent>(`/leads/${id}`, undefined, opts),
  create: (input: CreateLeadInput) => send<LeadWithParent>('POST', '/leads', input),
  /**
   * Moving to 'lost' is a guarded action: admin/superadmin get the updated Lead (200); other
   * roles get PendingApprovalResponse (202) and the lead is unchanged. Use isPendingApproval().
   */
  updateStatus: (id: string, status: LeadStatus, extra: { reason?: string } = {}) =>
    send<Lead | PendingApprovalResponse>('PATCH', `/leads/${id}/status`, { status, ...extra }),
  /** Bulk-load the enquiry sheet. dryRun previews counts/stages/problems without writing. */
  importRows: (rows: LeadImportRow[], dryRun = false) =>
    send<LeadImportResult>('POST', '/leads/import', { rows, dryRun }),
  qualify: (id: string, input: QualifyLeadInput) => send<Lead>('POST', `/leads/${id}/qualify`, input),
  /** "Mark as lost": same guarded semantics as updateStatus(id, 'lost'). */
  markLost: (id: string) => send<Lead | PendingApprovalResponse>('DELETE', `/leads/${id}`),
};

// ── parents (leads:manage) ───────────────────────────────────

export interface CreateParentInput {
  fullName: string;
  whatsappNumber: string;
  email?: string;
  address?: string;
}

export const parents = {
  list: (opts?: Signal) => get<ParentListItem[]>('/parents', undefined, opts),
  get: (id: string, opts?: Signal) => get<ParentDetail>(`/parents/${id}`, undefined, opts),
  create: (input: CreateParentInput) => send<Parent>('POST', '/parents', input),
};

// ── students ─────────────────────────────────────────────────

export interface OnboardLeadInput {
  leadId: string;
  studentName: string;
  batchId?: string;
  dateOfBirth?: string;
  paymentReference: string;
  amountPaid: number;
  paymentMode?: string;
}

export const students = {
  /** students:read. Teachers only receive students in their own batches. */
  list: (opts?: Signal) => get<StudentListItem[]>('/students', undefined, opts),
  get: (id: string, opts?: Signal) => get<StudentDetail>(`/students/${id}`, undefined, opts),
  /** students:manage */
  create: (input: { parentId: string; fullName: string; dateOfBirth?: string; admissionDate?: string }) =>
    send<Student>('POST', '/students', input),
  /** students:manage. Bulk-registers students with parents and batch enrolments; dryRun previews. */
  importRows: (rows: StudentImportRow[], dryRun = false) =>
    send<StudentImportResult>('POST', '/students/import', { rows, dryRun }),
  /** students:manage. One student + parent + batches (same rules as the import). */
  register: (input: StudentImportRow) =>
    send<{ student: StudentDetail; created: boolean; enrollmentsAdded: number }>('POST', '/students/register', input),
  /** students:manage. Atomically creates student + payment + enrollment and marks the lead converted. */
  onboardLead: (input: OnboardLeadInput) => send<OnboardResult>('POST', '/students/onboard-lead', input),
};

// ── academic ─────────────────────────────────────────────────

export interface CreateRecordInput {
  studentId: string;
  subject: string;
  markObtained: number;
  totalMarks: number;
  attendancePercentage?: number;
  testDate?: string;
  teacherComments?: string;
}

export interface CreateBatchInput {
  courseId: string;
  batchName: string;
  startDate?: string;
  endDate?: string;
  teacherId?: string;
}

export interface UpdateBatchInput {
  batchName?: string;
  teacherId?: string | null;
  /** null detaches the standing link */
  classLinkId?: string | null;
  startDate?: string | null;
  endDate?: string | null;
}

export interface ScheduleSlotInput {
  dayOfWeek: number;
  /** HH:mm, 24-hour, IST */
  startTime: string;
  durationMinutes: number;
  /** Overrides the batch's standing link for this slot; null/omitted = use the batch link. */
  classLinkId?: string | null;
}

export interface TimetableImportRow {
  batchName: string;
  day: string;
  startTime: string;
  endTime: string;
  meetingUrl: string;
}

export interface TimetableImportResult {
  dryRun: boolean;
  batches: number;
  batchesToCreate: number;
  links: number;
  linksToCreate: number;
  slots: number;
}

export interface LeadImportRow {
  name: string;
  grade?: string;
  board?: string;
  phone: string;
  timeline?: string;
  notes?: string;
  remarks?: string;
}

export interface LeadImportResult {
  dryRun: boolean;
  created: number;
  skippedDuplicates: number;
  newParents: number;
  byStatus: Record<string, number>;
  invalid: { row: number; message: string }[];
}

export interface ClassLinkInput {
  name: string;
  meetingUrl: string;
  grade?: string | null;
  board?: string | null;
  subject?: string | null;
}

export const classLinks = {
  list: (opts?: Signal) => get<{ data: ClassLinkWithUsage[] }>('/class-links', undefined, opts),
  create: (input: ClassLinkInput) => send<ClassLinkWithUsage>('POST', '/class-links', input),
  /** Existing names are updated (and re-activated); nothing is deleted. */
  bulk: (links: ClassLinkInput[]) =>
    send<{ created: number; updated: number; total: number }>('POST', '/class-links/bulk', { links }),
  update: (id: string, input: Partial<ClassLinkInput> & { isActive?: boolean }) =>
    send<ClassLinkWithUsage>('PATCH', `/class-links/${id}`, input),
  /** 409 when a batch still uses it. */
  remove: (id: string) => send<void>('DELETE', `/class-links/${id}`),
  /**
   * Creates/updates batches, links and the weekly timetable from a pasted timetable. dryRun previews only.
   * A bad row rejects everything (400 with `details.errors` listing the rows).
   */
  timetableImport: (rows: TimetableImportRow[], dryRun = false) =>
    send<TimetableImportResult>('POST', '/class-links/timetable-import', { rows, dryRun }),
};

export const academic = {
  records: (studentId: string, opts?: Signal) =>
    get<AcademicRecord[]>(`/academic/students/${studentId}/records`, undefined, opts),
  createRecord: (input: CreateRecordInput) => send<AcademicRecord>('POST', '/academic/records', input),
  summary: (studentId: string, opts?: Signal) =>
    get<AcademicSummary>(`/academic/students/${studentId}/summary`, undefined, opts),
  courses: (opts?: Signal) => get<CourseWithBatches[]>('/academic/courses', undefined, opts),
  createCourse: (input: { courseName: string; description?: string }) => send<Course>('POST', '/academic/courses', input),
  /** Teachers only receive their own batches. */
  batches: (opts?: Signal) => get<BatchDetail[]>('/academic/batches', undefined, opts),
  createBatch: (input: CreateBatchInput) =>
    send<BatchWithCourse & { teacher: { id: string; fullName: string } | null }>('POST', '/academic/batches', input),
  batchStudents: (batchId: string, opts?: Signal) =>
    get<BatchRosterStudent[]>(`/academic/batches/${batchId}/students`, undefined, opts),
  updateBatch: (batchId: string, input: UpdateBatchInput) =>
    send<BatchDetail>('PATCH', `/academic/batches/${batchId}`, input),
  /** Replaces all weekly slots of the batch. */
  setSchedule: (batchId: string, slots: ScheduleSlotInput[]) =>
    send<BatchSchedule[]>('PUT', `/academic/batches/${batchId}/schedule`, { slots }),
  enroll: (batchId: string, studentId: string) =>
    send<Enrollment & { student: Student; batch: Batch }>('POST', `/academic/batches/${batchId}/enroll`, { studentId }),
};

// ── attendance (attendance:mark) ─────────────────────────────

export interface AbsenceNoticeResult {
  absent: number;
  notified: number;
  alreadyNotified: number;
  skippedOptedOut: number;
  noContact: number;
  failed: number;
}

export const attendance = {
  /** Tells parents (WhatsApp + email) their child was absent on the date. Once per student per day. */
  notifyAbsent: (batchId: string, date: string) =>
    send<AbsenceNoticeResult>('POST', `/attendance/batches/${batchId}/notify-absent`, { date }),
  /** Roster with the given YYYY-MM-DD's status per student (status null = unmarked). */
  roster: (batchId: string, date: string, opts?: Signal) =>
    get<AttendanceRoster>(`/attendance/batches/${batchId}`, { date }, opts),
  /** Bulk upsert for one date. Future dates are rejected by the backend. */
  mark: (batchId: string, date: string, entries: AttendanceMarkEntry[]) =>
    send<AttendanceMarkResult>('POST', `/attendance/batches/${batchId}`, { date, entries }),
  batchSummary: (batchId: string, from: string, to: string, opts?: Signal) =>
    get<AttendanceBatchSummary>(`/attendance/batches/${batchId}/summary`, { from, to }, opts),
  studentHistory: (studentId: string, from: string, to: string, opts?: Signal) =>
    get<StudentAttendanceHistory>(`/attendance/students/${studentId}`, { from, to }, opts),
};

// ── class sessions (sessions:manage) ─────────────────────────

export interface CreateSessionInput {
  batchId: string;
  topic?: string;
  /** ISO datetime with offset, e.g. 2026-10-20T16:00:00+05:30 */
  startsAt: string;
  durationMinutes?: number;
  /** https; omit to use the batch's standing class link */
  meetingUrl?: string;
  notes?: string;
}

export interface UpdateSessionInput {
  topic?: string | null;
  startsAt?: string;
  durationMinutes?: number;
  meetingUrl?: string;
  notes?: string | null;
}

export const sessions = {
  today: (opts?: Signal) => get<ClassSessionWithBatch[]>('/sessions/today', undefined, opts),
  list: (params: { batchId?: string; date?: string } = {}, opts?: Signal) =>
    get<ClassSessionWithBatch[]>('/sessions', { ...params }, opts),
  create: (input: CreateSessionInput) => send<ClassSessionWithBatch>('POST', '/sessions', input),
  update: (id: string, input: UpdateSessionInput) => send<ClassSessionWithBatch>('PATCH', `/sessions/${id}`, input),
  remove: (id: string) => send<void>('DELETE', `/sessions/${id}`),
  /** 409 when already announced. */
  announce: (id: string) => send<AnnounceResult>('POST', `/sessions/${id}/announce`),
};

// ── weekly reports (reports:review) ──────────────────────────

export interface ReportListParams {
  status?: ReportStatus;
  /** YYYY-MM-DD, must be a Monday to match stored reports */
  weekStart?: string;
  batchId?: string;
}

export const reports = {
  list: (params: ReportListParams = {}, opts?: Signal) => get<WeeklyReportListItem[]>('/reports', { ...params }, opts),
  get: (id: string, opts?: Signal) => get<WeeklyReportDetail>(`/reports/${id}`, undefined, opts),
  /** weekStart must be a Monday (defaults to the current week on the server). */
  generate: (input: { weekStart?: string; batchId?: string; force?: boolean } = {}) =>
    send<GenerateReportsResult>('POST', '/reports/generate', input),
  /** Only drafts can be edited (409 otherwise). */
  updateSummary: (id: string, summary: string) => send<WeeklyReport>('PATCH', `/reports/${id}`, { summary }),
  approve: (id: string) => send<WeeklyReport>('POST', `/reports/${id}/approve`),
  bulkApprove: (ids: string[]) => send<BulkApproveResult>('POST', '/reports/bulk-approve', { ids }),
  /** 502 when delivery failed, 422 when skipped (e.g. opted out): both surface as ApiError with the reason. */
  send: (id: string) => send<{ outcome: SendOutcome; report: WeeklyReport | null }>('POST', `/reports/${id}/send`),
  sendApproved: () => send<SendApprovedResult>('POST', '/reports/send-approved'),
};

// ── reminder rules (reminders:manage) ────────────────────────

export const reminders = {
  list: (opts?: Signal) => get<ReminderRule[]>('/reminders', undefined, opts),
  get: (id: string, opts?: Signal) => get<ReminderRule>(`/reminders/${id}`, undefined, opts),
  create: (input: ReminderRuleInput) => send<ReminderRule>('POST', '/reminders', input),
  update: (id: string, input: Partial<ReminderRuleInput>) => send<ReminderRule>('PATCH', `/reminders/${id}`, input),
  remove: (id: string) => send<void>('DELETE', `/reminders/${id}`),
  runNow: (id: string) => send<RuleRunResult>('POST', `/reminders/${id}/run-now`),
};

// ── appointments (leads:manage) ──────────────────────────────

export interface CalendarSlot {
  time: string;
  iso: string;
  formatted: string;
  available: true;
}

export interface CalendarAvailability {
  date: string;
  timezone: string;
  bookedCount: number;
  availableSlots: CalendarSlot[];
  bookedAppointments: Pick<Appointment, 'id' | 'scheduledAt' | 'durationMinutes' | 'status'>[];
}

export const appointments = {
  list: (status?: AppointmentStatus, opts?: Signal) => get<AppointmentWithLead[]>('/appointments', { status }, opts),
  /** date = YYYY-MM-DD (IST); defaults to today on the server. */
  checkCalendar: (params: { date?: string; durationMinutes?: number } = {}, opts?: Signal) =>
    get<CalendarAvailability>('/appointments/check-calendar', { ...params }, opts),
  /** Also moves the lead to demo_scheduled. 409 on slot clash. */
  book: (input: { leadId: string; scheduledAt: string; durationMinutes?: number }) =>
    send<AppointmentWithLead>('POST', '/appointments', input),
  updateStatus: (id: string, status: AppointmentStatus) => send<Appointment>('PATCH', `/appointments/${id}/status`, { status }),
};

// ── dashboard (dashboard:view) ───────────────────────────────

export const dashboard = {
  kpis: (opts?: Signal) => get<DashboardKpis>('/dashboard/kpis', undefined, opts),
  leadPipeline: (opts?: Signal) => get<LeadPipeline>('/dashboard/lead-pipeline', undefined, opts),
  studentHealth: (opts?: Signal) => get<StudentHealthEntry[]>('/dashboard/student-health', undefined, opts),
  funnelAnalytics: (opts?: Signal) => get<FunnelAnalytics>('/dashboard/funnel-analytics', undefined, opts),
  academicAnalytics: (opts?: Signal) => get<AcademicAnalytics>('/dashboard/academic-analytics', undefined, opts),
  overview: (days = 30, opts?: Signal) => get<DashboardOverview>('/dashboard/overview', { days }, opts),
};

// ── agents ───────────────────────────────────────────────────

export const agents = {
  /** agents:view */
  status: (opts?: Signal) => get<AgentStatus[]>('/agents/status', undefined, opts),
  activityLog: (params: { agentId?: string; limit?: number } = {}, opts?: Signal) =>
    get<AiActivityLog[]>('/agents/activity-log', { ...params }, opts),
  activityForTarget: (targetId: string, opts?: Signal) =>
    get<AiActivityLog[]>(`/agents/activity-log/target/${targetId}`, undefined, opts),
  /** CSV text of the latest 1000 log rows. */
  exportActivityLog: (opts?: Signal) => requestText('/agents/activity-log/export', { signal: opts?.signal }),
  exceptions: (opts?: Signal) => get<ExceptionItem[]>('/agents/exceptions', undefined, opts),
  founderBriefing: (opts?: Signal) => get<FounderBriefing>('/agents/founder-briefing', undefined, opts),
  /** status defaults to 'pending' on the server. */
  approvalQueue: (status: ApprovalStatus | 'all' = 'pending', opts?: Signal) =>
    get<Approval[]>('/agents/approval-queue', { status }, opts),
  /** approvals:decide (high-risk items need approvals:decide_high_risk; 403 otherwise). */
  decideApproval: (id: string, decision: 'approved' | 'rejected', note?: string) =>
    send<ApprovalDecisionResponse>('POST', `/agents/approval-queue/${id}/decision`, { decision, note }),
  // agents:run
  runDemoReminders: () => send<RoutineResponse<DemoReminderResult>>('POST', '/agents/routines/reminders/run'),
  runFollowup: () => send<RoutineResponse<FollowupResult>>('POST', '/agents/routines/followup/run'),
  runAcademicMonitoring: () => send<RoutineResponse<AcademicScanResult>>('POST', '/agents/routines/academic-monitoring/run'),
  /** toPhone optional: falls back to FOUNDER_WHATSAPP_NUMBER server-side (400 if neither). */
  runDailyBriefing: (toPhone?: string) =>
    send<RoutineResponse<BriefingDispatchResult>>('POST', '/agents/routines/daily-briefing/run', toPhone ? { toPhone } : {}),
  runProgressReports: () => send<RoutineResponse<ProgressReportsResult>>('POST', '/agents/routines/progress-reports/run'),
  sendStudentProgressReport: (studentId: string) =>
    send<StudentProgressReportResult>('POST', `/agents/students/${studentId}/progress-report`),
};

// ── messages ─────────────────────────────────────────────────

export interface MessageHistoryParams {
  /** exactly one of these is required by the backend */
  leadId?: string;
  parentId?: string;
  studentId?: string;
  page?: number;
  pageSize?: number;
}

export const messages = {
  /** dashboard:view. Gateway state is always a valid 200 response (even 'unreachable'). */
  status: (opts?: Signal) => get<WhatsAppStatus>('/messages/status', undefined, opts),
  /** leads:manage. Oldest first within the page. */
  history: (params: MessageHistoryParams, opts?: Signal) => get<MessageHistory>('/messages', { ...params }, opts),
  /** leads:manage. Queues a manual WhatsApp to the lead's parent (202). 409 when the parent opted out. */
  sendToLead: (leadId: string, text: string) =>
    send<{ status: 'queued'; leadId: string }>('POST', `/messages/lead/${leadId}`, { text }),
};

// ── voice calls ──────────────────────────────────────────────

export interface CallListParams {
  leadId?: string;
  parentId?: string;
  page?: number;
  limit?: number;
}

export const calls = {
  /** leads:manage. Newest first, transcript included. */
  list: (params: CallListParams, opts?: Signal) => get<CallLogList>('/calls', { ...params }, opts),
  get: (id: string, opts?: Signal) => get<CallLog>(`/calls/${id}`, undefined, opts),
};

// ── developer console (dev:console) ──────────────────────────

export const dev = {
  config: (opts?: Signal) => get<DevConfigResponse>('/dev/config', undefined, opts),
  updateConfig: (input: DevConfigUpdate) => send<StatusMessage>('POST', '/dev/config', input),
  testWhatsApp: (to: string, message?: string) =>
    send<{ status: string; result: unknown }>('POST', '/dev/test-whatsapp', { to, message }),
  connectWhatsApp: (phone: string) => send<{ status: string; code: string }>('POST', '/dev/whatsapp/connect', { phone }),
  confirmWhatsAppConnected: () => send<{ status: string; result: unknown }>('POST', '/dev/whatsapp/confirm-connected'),
  clearRedisCache: () => send<ClearCacheResult>('POST', '/dev/clear-redis-cache'),
  /** online:false (HTTP 200/502) means the daemon is unreachable: see `error`. */
  ollamaModels: (opts?: Signal) => get<OllamaModelsResponse>('/dev/ollama/models', undefined, opts),
  ollamaTest: (input: OllamaPrompt = {}) => send<OllamaTestResult>('POST', '/dev/ollama/test', input),
  /** SSE streaming generation; see streamOllama. */
  ollamaStream: streamOllama,
  simulateWhatsApp: (message: string, history: WhatsAppSimulateHistoryItem[] = []) =>
    send<WhatsAppSimulateResult>('POST', '/dev/whatsapp/simulate', { message, history }),
  llmMonitor: (opts?: Signal) => get<LlmMonitorResponse>('/dev/llm-monitor', undefined, opts),
  resetLlmMonitor: () => send<StatusMessage>('POST', '/dev/llm-monitor/reset'),
  /** Always 200: reachable:false means the call agent is down. */
  voiceStatus: (opts?: Signal) => get<VoiceStatus>('/dev/voice/status', undefined, opts),
};

export { streamOllama };

/** Single namespace import for convenience: `import { api } from '../services/api'`. */
export const api = {
  auth,
  users,
  leads,
  parents,
  students,
  academic,
  classLinks,
  attendance,
  sessions,
  reports,
  reminders,
  appointments,
  dashboard,
  agents,
  messages,
  calls,
  dev,
};
