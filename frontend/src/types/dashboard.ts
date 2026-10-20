import type { LeadStatus } from './lead-stages';
import type { LeadSource, LeadWithParent, StudentStatus, Parent, IsoDate } from './models';

export type HealthStatus = 'GREEN' | 'YELLOW' | 'RED' | 'UNKNOWN';

export interface HealthThresholds {
  green: number;
  yellow: number;
}

export interface DashboardKpis {
  totalLeads: number;
  convertedLeads: number;
  /** Pre-formatted by the server, e.g. "12%". */
  conversionRate: string;
  activeStudents: number;
  demoScheduled: number;
  aiActionsToday: number;
  leadsByStage: Record<LeadStatus, number>;
}

export interface LeadPipeline {
  pipeline: { status: LeadStatus; count: number }[];
  leads: LeadWithParent[];
}

export interface StudentHealthEntry {
  id: string;
  fullName: string;
  status: StudentStatus;
  admissionDate: IsoDate | null;
  parent: Pick<Parent, 'id' | 'fullName'>;
  health: HealthStatus;
  healthScore: number | null;
  averagePercentage: number | null;
  attendancePercentage: number | null;
  attendanceWindowDays: number;
  subjectAverages: { subject: string; averagePercentage: number; testsCount: number }[];
  lastAssessment: { subject: string | null; testDate: IsoDate | null; percentage: number } | null;
}

export interface FunnelStage {
  stage: LeadStatus;
  count: number;
  reached: number;
  conversionFromFirst: number | null;
  dropOffFromPrevious: number | null;
}

export interface FunnelAnalytics {
  totalLeads: number;
  stages: FunnelStage[];
  lost: { stage: 'lost'; count: number; shareOfAllLeads: number | null };
  overallConversionRate: number | null;
}

export interface AcademicAnalytics {
  batchStats: {
    batchId: string;
    batchName: string | null;
    courseTitle: string;
    studentCount: number;
    averagePercentage: number | null;
    cohorts: { green: number; yellow: number; red: number };
  }[];
  subjectRankings: { subject: string; averagePercentage: number; testsCount: number }[];
  totalRecordsAnalyzed: number;
}

export interface DashboardOverview {
  days: number;
  timezone: string;
  since: IsoDate;
  leads: {
    total: number;
    bySource: { source: LeadSource | 'Unknown'; count: number }[];
    newLeadsPerDay: { date: string; count: number }[];
  };
  demosThisWeek: number;
  /** Percentage (one decimal) or null when there are no leads in the window. */
  conversionRate: number | null;
  activeStudents: number;
  /** null when no Payment rows exist in the window. */
  revenue: number | null;
  batches: {
    batchId: string;
    batch: string | null;
    course: string;
    teacher: { id: string; name: string } | null;
    students: number;
    avgScore: number | null;
    attendance: number | null;
    health: HealthStatus;
  }[];
  healthThresholds: HealthThresholds;
}
