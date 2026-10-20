import { agents } from '../../services/api';
import type { BriefingDispatchResult, DemoReminderResult, FollowupResult, AcademicScanResult, ProgressReportsResult } from '../../types';

export interface Routine {
  /** What the routine does, shown on the Trigger button. */
  label: string;
  run: () => Promise<{ message: string; ok: boolean }>;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Agents that own a real routine endpoint (POST /agents/routines/:name/run, permission agents:run).
 * Any agentId not listed here has no manual trigger in the backend, so no button is shown.
 */
export const ROUTINES: Readonly<Record<string, Routine>> = {
  AdmissionsAI: {
    label: 'Run follow-ups',
    run: async () => {
      const r: FollowupResult = (await agents.runFollowup()).result;
      return { ok: true, message: `Follow-ups done: ${plural(r.followedUpCount, 'lead')} contacted, ${r.skippedOptedOut} opted out, ${r.skippedRateLimited} rate-limited.` };
    },
  },
  DemoCoordinatorAI: {
    label: 'Run reminders',
    run: async () => {
      const r: DemoReminderResult = (await agents.runDemoReminders()).result;
      return { ok: true, message: `Demo reminders: ${r.sent24h} sent (24h), ${r.sent1h} sent (1h), ${r.failed} failed, ${r.skippedOptedOut} opted out.` };
    },
  },
  AcademicMonitoringAI: {
    label: 'Run scan',
    run: async () => {
      const r: AcademicScanResult = (await agents.runAcademicMonitoring()).result;
      return { ok: true, message: `Scanned ${plural(r.totalScanned, 'student')}: ${r.greenCount} green, ${r.yellowCount} yellow, ${r.redCount} red, ${r.unknownCount} unknown.` };
    },
  },
  ChiefOfStaffAI: {
    label: 'Send briefing',
    run: async () => {
      const r: BriefingDispatchResult = (await agents.runDailyBriefing()).result;
      return { ok: r.success, message: r.success ? 'Daily briefing sent to the founder.' : 'The daily briefing was generated but not delivered.' };
    },
  },
  ParentEngagementAI: {
    label: 'Send progress reports',
    run: async () => {
      const r: ProgressReportsResult = (await agents.runProgressReports()).result;
      return { ok: true, message: `Progress reports: ${r.totalSent} sent, ${r.failures} failed.` };
    },
  },
};
