import type { HealthStatus } from './dashboard';

export interface AgentStatus {
  agentId: string;
  lastAction: string | null;
  actionsToday: number;
}

export interface ExceptionItem {
  id: string;
  type: 'AI_TOOL_FAILURE' | 'FLAGGED_EXCEPTION' | 'STALLED_LEAD' | 'CRITICAL_STUDENT_HEALTH' | 'ATTENDANCE_DROP';
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  title: string;
  details: string;
  targetId?: string;
  timestamp: string;
}

export interface FounderBriefing {
  date: string;
  metrics: {
    totalLeads: number;
    qualifiedLeads: number;
    demosScheduled: number;
    activeStudents: number;
    healthDistribution: { green: number; yellow: number; red: number };
    aiActionsToday: number;
    exceptionsCount: number;
  };
  briefingText: string;
}

export interface RoutineResponse<T> {
  status: 'completed';
  result: T;
}

export interface DemoReminderResult {
  sent24h: number;
  sent1h: number;
  failed: number;
  skippedOptedOut: number;
}

export interface FollowupResult {
  followedUpCount: number;
  skippedOptedOut: number;
  skippedRateLimited: number;
}

export interface AcademicScanResult {
  totalScanned: number;
  greenCount: number;
  yellowCount: number;
  redCount: number;
  unknownCount: number;
  /** Shape owned by the backend StudentDiagnosis; only the health band is relied upon here. */
  diagnoses: { studentId?: string; health?: HealthStatus; [key: string]: unknown }[];
}

export interface ProgressReportsResult {
  totalSent: number;
  failures: number;
}

export interface BriefingDispatchResult {
  success: boolean;
  preview: string;
}

export interface StudentProgressReportResult {
  success: boolean;
  message?: string;
}

/** Response of POST /agents/approval-queue/:id/decision. */
export interface ApprovalDecisionResponse {
  status: string;
  item: import('./models').Approval;
}
