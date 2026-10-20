import type { LeadStatus } from './lead-stages';
import type { Permission, Role } from './permissions';

/** ISO-8601 timestamp or date string as serialised by the backend. */
export type IsoDate = string;
/** Prisma Decimal columns serialise as strings; tolerate numbers too. */
export type Decimal = string | number;

export interface Paginated<T> {
  data: T[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

// ── Users ────────────────────────────────────────────────────

export interface User {
  id: string;
  fullName: string;
  email: string;
  role: Role;
  phone: string | null;
  /** Short faculty code used on the timetable, e.g. BPY */
  initials: string | null;
  isActive: boolean;
  createdAt: IsoDate;
}

/** GET /auth/me. */
export interface SessionUser extends User {
  permissions: Permission[];
}

/** POST /auth/login (user subset: no phone/isActive/createdAt). */
export interface LoginResponse {
  token: string;
  user: Pick<SessionUser, 'id' | 'fullName' | 'email' | 'role' | 'permissions'>;
}

/**
 * Step 1 of login (email + password) never returns a session: it emails a 6-digit code and hands
 * back this challenge, which /auth/verify-otp or /auth/resend-otp take an otpToken from.
 */
export interface LoginOtpChallenge {
  otpRequired: true;
  otpToken: string;
  expiresInSeconds: number;
  /** True for configured dev/test accounts: no real email is sent, a fixed code is used instead. */
  devBypass: boolean;
  /** e.g. "jo***@example.com", for "we sent a code to ..." messaging without exposing the full address. */
  maskedEmail: string;
}

// ── Parents & leads ──────────────────────────────────────────

export interface Parent {
  id: string;
  fullName: string;
  whatsappNumber: string;
  email: string | null;
  address: string | null;
  optedOut: boolean;
  optedOutAt: IsoDate | null;
  createdAt: IsoDate;
}

export const LEAD_SOURCES = ['Meta', 'Website', 'Referral', 'GoogleSheets'] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

export type AppointmentStatus = 'scheduled' | 'completed' | 'cancelled' | 'no_show';

export interface Appointment {
  id: string;
  leadId: string;
  scheduledAt: IsoDate;
  durationMinutes: number;
  status: AppointmentStatus;
  feedback: string | null;
  createdAt: IsoDate;
}

export type LeadTimeline = 'immediately' | 'within_week' | 'when_program_starts' | 'just_enquiring';

export const LEAD_TIMELINE_LABELS: Record<LeadTimeline, string> = {
  immediately: 'Immediately',
  within_week: 'Within 1 week',
  when_program_starts: 'When the program starts',
  just_enquiring: 'Just enquiring',
};

export interface Lead {
  id: string;
  parentId: string;
  source: LeadSource | null;
  status: LeadStatus;
  gradeInterested: string | null;
  boardInterested: string | null;
  subjectsInterested: string[];
  requirements: string | null;
  assignedAgentId: string | null;
  aiScore: number | null;
  timeline: LeadTimeline | null;
  notes: string | null;
  createdAt: IsoDate;
  updatedAt: IsoDate;
}

export interface LeadWithParent extends Lead {
  parent: Parent;
  appointments?: Appointment[];
}

export interface AppointmentWithLead extends Appointment {
  lead: LeadWithParent;
}

// ── Academic ─────────────────────────────────────────────────

export interface Course {
  id: string;
  courseName: string;
  description: string | null;
}

export interface Batch {
  id: string;
  courseId: string;
  batchName: string | null;
  startDate: IsoDate | null;
  endDate: IsoDate | null;
  teacherId: string | null;
  classLinkId: string | null;
}

/** A standing meeting link (e.g. a Teams room) reused for a class group for the student's whole journey. */
export interface ClassLink {
  id: string;
  name: string;
  meetingUrl: string;
  grade: string | null;
  board: string | null;
  subject: string | null;
  isActive: boolean;
  createdAt: IsoDate;
  updatedAt: IsoDate;
}

export interface ClassLinkWithUsage extends ClassLink {
  _count: { batches: number };
}

/** Recurring weekly class slot of a batch, in IST. dayOfWeek: 0 = Sunday ... 6 = Saturday. */
export interface BatchSchedule {
  id: string;
  batchId: string;
  dayOfWeek: number;
  startTime: string;
  durationMinutes: number;
  /** Overrides the batch's standing link for this slot; null = use the batch link. */
  classLinkId: string | null;
}

export type StudentStatus = 'active' | 'inactive' | 'graduated';

export interface Student {
  id: string;
  parentId: string;
  fullName: string;
  dateOfBirth: IsoDate | null;
  admissionDate: IsoDate | null;
  grade: string | null;
  board: string | null;
  status: StudentStatus;
  createdAt: IsoDate;
}

export interface Enrollment {
  id: string;
  studentId: string;
  batchId: string;
  enrollmentDate: IsoDate;
}

export interface AcademicRecord {
  id: string;
  studentId: string;
  subject: string | null;
  markObtained: Decimal | null;
  totalMarks: Decimal | null;
  attendancePercentage: Decimal | null;
  testDate: IsoDate | null;
  teacherComments: string | null;
  createdAt: IsoDate;
}

export type BatchWithCourse = Batch & { course: Course };
export type EnrollmentWithBatch = Enrollment & { batch: BatchWithCourse };

export interface StudentListItem extends Student {
  parent: Parent;
  enrollments: EnrollmentWithBatch[];
}

export interface StudentDetail extends StudentListItem {
  academicRecords: AcademicRecord[];
}

export interface ParentListItem extends Parent {
  leads: Lead[];
  students: Student[];
}

export interface ParentDetail extends Parent {
  leads: Lead[];
  students: (Student & { academicRecords: AcademicRecord[] })[];
}

export interface CourseWithBatches extends Course {
  batches: Batch[];
}

export interface BatchDetail extends BatchWithCourse {
  teacher: { id: string; fullName: string; email: string } | null;
  classLink: Pick<ClassLink, 'id' | 'name' | 'meetingUrl' | 'isActive'> | null;
  schedules: BatchSchedule[];
  enrollments: (Enrollment & { student: Pick<Student, 'id' | 'fullName' | 'status'> })[];
}

export interface BatchRosterStudent extends Student {
  parent: { id: string; fullName: string };
  academicRecords: AcademicRecord[];
}

export interface SubjectSummary {
  subject: string;
  averagePercentage: number;
  assessments: number;
  flag: 'WEAK' | 'OK';
}

/** GET /academic/students/:id/summary: `subjectSummary` is absent when the student has no records. */
export interface AcademicSummary {
  studentId: string;
  subjectSummary?: SubjectSummary[];
  summary?: null;
  message?: string;
}

export interface Payment {
  id: string;
  leadId: string | null;
  studentId: string | null;
  reference: string;
  amount: Decimal;
  currency: string;
  method: string | null;
  recordedById: string | null;
  paidAt: IsoDate;
  createdAt: IsoDate;
}

export interface OnboardResult {
  student: Student & { parent: Parent };
  enrollment: EnrollmentWithBatch | null;
  payment: Payment;
  welcomeMessage: 'queued' | 'skipped_no_number' | 'skipped_opted_out' | 'failed';
}

// ── Attendance & sessions ────────────────────────────────────

export type AttendanceStatus = 'present' | 'absent' | 'late' | 'excused';

export interface Attendance {
  id: string;
  studentId: string;
  batchId: string;
  date: IsoDate;
  status: AttendanceStatus;
  note: string | null;
  markedById: string | null;
  createdAt: IsoDate;
  updatedAt: IsoDate;
}

export interface AttendanceRosterEntry {
  studentId: string;
  fullName: string;
  studentStatus: StudentStatus;
  /** null = not marked yet for the date */
  status: AttendanceStatus | null;
  note: string | null;
}

export interface AttendanceRoster {
  batchId: string;
  date: string;
  roster: AttendanceRosterEntry[];
}

export interface AttendanceMarkEntry {
  studentId: string;
  status: AttendanceStatus;
  note?: string;
}

export interface AttendanceMarkResult {
  batchId: string;
  date: string;
  saved: number;
}

export interface AttendanceBatchSummary {
  batchId: string;
  from: string;
  to: string;
  classDays: string[];
  students: {
    studentId: string;
    fullName: string;
    daysMarked: number;
    presentDays: number;
    percentage: number | null;
    unmarkedDays: string[];
  }[];
}

export interface StudentAttendanceHistory {
  studentId: string;
  fullName: string;
  from: string;
  to: string;
  markedDays: number;
  presentDays: number;
  percentage: number | null;
  history: (Attendance & { batch: { id: string; batchName: string | null } })[];
}

export interface ClassSession {
  id: string;
  batchId: string;
  topic: string | null;
  startsAt: IsoDate;
  durationMinutes: number;
  meetingUrl: string;
  notes: string | null;
  createdById: string | null;
  announcedAt: IsoDate | null;
  createdAt: IsoDate;
}

export interface ClassSessionWithBatch extends ClassSession {
  batch: { id: string; batchName: string | null };
}

export interface AnnounceResult {
  sessionId: string;
  parentsMessaged: number;
  parentsSkippedOptedOut: number;
  teacherMessaged: boolean;
  teacherSkippedReason?: string;
}

// ── Reports & reminders ──────────────────────────────────────

export type ReportStatus = 'draft' | 'approved' | 'sent' | 'failed';

export interface WeeklyReportMetrics {
  weekStart: string;
  weekEnd: string;
  attendance: {
    markedDays: number;
    attendedDays: number;
    absentDays: number;
    excusedDays: number;
    percentage: number | null;
    previousPercentage: number | null;
  };
  marks: {
    assessments: number;
    percentage: number | null;
    previousPercentage: number | null;
    trend: 'up' | 'down' | 'steady' | null;
    trendDelta: number | null;
    subjects: { subject: string; percentage: number; assessments: number }[];
  };
  weakSubjects: string[];
  summarySource: 'template' | 'llm';
}

export interface WeeklyReport {
  id: string;
  studentId: string;
  weekStart: IsoDate;
  summary: string;
  /** Free-form JSON column; WeeklyReportMetrics when generated by the backend. */
  metrics: WeeklyReportMetrics | null;
  status: ReportStatus;
  approvedById: string | null;
  approvedAt: IsoDate | null;
  sentAt: IsoDate | null;
  createdAt: IsoDate;
}

export interface WeeklyReportListItem extends WeeklyReport {
  student: { id: string; fullName: string; parent: { id: string; fullName: string; optedOut: boolean } };
}

export interface WeeklyReportDetail extends WeeklyReport {
  student: { id: string; fullName: string };
}

export interface GenerateReportsResult {
  weekStart: string;
  created: number;
  regenerated: number;
  keptExisting: number;
  failed: { studentId: string; error: string }[];
}

export type SendOutcome =
  | { reportId: string; outcome: 'sent' }
  | { reportId: string; outcome: 'skipped'; reason: string }
  | { reportId: string; outcome: 'failed'; reason: string };

export interface SendApprovedResult {
  sent: number;
  skipped: SendOutcome[];
  failed: SendOutcome[];
}

export interface BulkApproveResult {
  approved: string[];
  skipped: { id: string; reason: string }[];
}

export type ReminderAudience = 'teacher' | 'parent';

export interface ReminderRule {
  id: string;
  name: string;
  audience: ReminderAudience;
  /** 0 = Sunday ... 6 = Saturday */
  dayOfWeek: number;
  /** HH:mm, Asia/Kolkata */
  timeOfDay: string;
  template: string;
  enabled: boolean;
  lastRunAt: IsoDate | null;
  createdById: string | null;
  createdAt: IsoDate;
}

export interface ReminderRuleInput {
  name: string;
  audience: ReminderAudience;
  dayOfWeek: number;
  timeOfDay: string;
  template: string;
  enabled?: boolean;
}

export interface RuleRunResult {
  ruleId: string;
  ruleName: string;
  audience: string;
  sent: number;
  skipped: { teacherId: string; name: string; reason: string }[];
  failed: { teacherId: string; name: string; error: string }[];
  note?: string;
}

/** Placeholders the backend accepts inside reminder templates ({{name}}). */
export const REMINDER_TEMPLATE_PLACEHOLDERS = ['teacherName', 'pendingAttendanceDays', 'batchNames', 'sessionsToday'] as const;

// ── Messaging ────────────────────────────────────────────────

export type MessageDirection = 'inbound' | 'outbound';
export type MessageChannel = 'whatsapp' | 'call' | 'system' | 'email';

export interface Message {
  id: string;
  parentId: string | null;
  leadId: string | null;
  studentId: string | null;
  direction: MessageDirection;
  channel: MessageChannel;
  subject?: string | null;
  body: string;
  status: string | null;
  externalId: string | null;
  agentId: string | null;
  createdAt: IsoDate;
}

export interface MessageHistory {
  data: Message[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export type GatewayState = 'connected' | 'disconnected' | 'unreachable' | 'not_configured';

export interface WhatsAppStatus {
  state: GatewayState;
  connected: boolean;
  loggedIn: boolean;
  name?: string;
  jid?: string;
  instance: string;
  error?: string;
  /** Outgoing email (Resend) configuration; absent on older servers. */
  email?: EmailStatus;
}

export interface EmailStatus {
  enabled: boolean;
  domain: string;
  senders: string[];
}

// ── Approvals & AI activity ──────────────────────────────────

export type ApprovalRisk = 'low' | 'medium' | 'high';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'executed' | 'failed';

export interface Approval {
  id: string;
  agentId: string;
  actionType: string;
  title: string;
  reason: string | null;
  payload: Record<string, unknown>;
  targetId: string | null;
  risk: ApprovalRisk;
  status: ApprovalStatus;
  decidedById: string | null;
  decidedAt: IsoDate | null;
  decisionNote: string | null;
  result: Record<string, unknown> | null;
  createdAt: IsoDate;
}

export type AiActivityStatus = 'success' | 'failure' | 'pending';

export interface AiActivityLog {
  /** BigInt on the server, serialised as a string. */
  id: string;
  agentId: string;
  targetId: string | null;
  actionType: string | null;
  payload: Record<string, unknown> | null;
  status: AiActivityStatus;
  timestamp: IsoDate;
}

/** Response of POST /leads/:id/status (lost) and DELETE /leads/:id when the caller may not apply it directly. */
export interface PendingApprovalResponse {
  pendingApproval: true;
  approvalId: string;
  message: string;
}

// ── Voice calls (leads:manage) ───────────────────────────────

export type CallOutcome = 'demo_booked' | 'callback_requested' | 'not_interested' | 'info_only' | 'dropped' | 'unknown';

export interface CallTranscriptTurn {
  role: 'agent' | 'caller';
  text: string;
  ts: string | number;
}

/** GET /calls rows (backend CallLog). `outcome` is free text in the DB; known values are CallOutcome. */
export interface CallLog {
  id: string;
  callId: string;
  parentId: string | null;
  leadId: string | null;
  phone: string | null;
  transcript: CallTranscriptTurn[];
  summary: string | null;
  outcome: string | null;
  durationSec: number | null;
  createdAt: string;
}

export interface CallLogList {
  data: CallLog[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}
