import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { aiActivityLogService } from './ai-activity-log.service';
import { notifyUser } from './notify.service';
import { isEmailEnabled } from './email.service';
import { enqueueWhatsApp } from '../utils/queues';
import { approvalService } from './approval.service';

export interface ExceptionItem {
  id: string;
  type: 'AI_TOOL_FAILURE' | 'FLAGGED_EXCEPTION' | 'STALLED_LEAD' | 'CRITICAL_STUDENT_HEALTH' | 'ATTENDANCE_DROP';
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  title: string;
  details: string;
  targetId?: string;
  timestamp: string;
}

export class ChiefOfStaffService {
  /**
   * Synthesizes the daily founder operational briefing
   */
  async generateDailyBriefing(): Promise<{
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
  }> {
    const todayStart = new Date(new Date().setHours(0, 0, 0, 0));

    // Parallel metric retrieval
    const [
      totalLeads,
      qualifiedLeads,
      demosScheduled,
      convertedCount,
      activeStudents,
      studentsList,
      todayAiLogs,
      pendingApprovals,
    ] = await Promise.all([
      prisma.lead.count(),
      prisma.lead.count({ where: { status: 'qualified' } }),
      prisma.lead.count({ where: { status: 'demo_scheduled' } }),
      prisma.lead.count({ where: { status: 'converted' } }),
      prisma.student.count({ where: { status: 'active' } }),
      prisma.student.findMany({
        where: { status: 'active' },
        include: { academicRecords: true },
      }),
      prisma.aiActivityLog.findMany({
        where: { timestamp: { gte: todayStart } },
      }),
      prisma.approval.count({ where: { status: 'pending' } }),
    ]);

    // Compute academic health distribution
    let green = 0;
    let yellow = 0;
    let red = 0;
    const criticalStudentNames: string[] = [];

    for (const st of studentsList) {
      const records = st.academicRecords;
      if (records.length === 0) {
        yellow++;
        continue;
      }
      const avg =
        records.reduce((acc, r) => acc + ((Number(r.markObtained ?? 0) / Number(r.totalMarks ?? 1)) * 100), 0) /
        records.length;

      if (avg >= 70) green++;
      else if (avg >= 50) yellow++;
      else {
        red++;
        criticalStudentNames.push(`${st.fullName} (${Math.round(avg)}%)`);
      }
    }

    const failedLogs = todayAiLogs.filter((l) => l.status === 'failure');
    const exceptionsCount = failedLogs.length + red;

    const dateStr = new Date().toLocaleDateString('en-IN', {
      weekday: 'long',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });

    let text = `☀️ *E-KALAVYA FOUNDER DAILY BRIEFING*\n`;
    text += `📅 *${dateStr}*\n`;
    text += `━━━━━━━━━━━━━━━━━━━━━\n\n`;

    text += `📈 *Admissions Funnel*:\n`;
    text += `• Total Pipeline: *${totalLeads}* leads\n`;
    text += `• Qualified by Admissions AI: *${qualifiedLeads}*\n`;
    text += `• Demos Scheduled: *${demosScheduled}*\n`;
    text += `• Enrolled Admissions: *${convertedCount}*\n\n`;

    text += `🎓 *Academic Health Status*:\n`;
    text += `• Active Students: *${activeStudents}*\n`;
    text += `• Performance Cohorts: 🟢 *${green}* Thriving | 🟡 *${yellow}* Moderate | 🔴 *${red}* Critical\n`;
    if (criticalStudentNames.length > 0) {
      text += `• ⚠️ Students Requiring Support: ${criticalStudentNames.join(', ')}\n`;
    }
    text += `\n`;

    text += `🤖 *AI Workforce Operations*:\n`;
    text += `• Actions Executed Today: *${todayAiLogs.length}*\n`;
    text += `• Failed Tool Executions: *${failedLogs.length}*\n`;
    text += `• Pending Approval Items: *${pendingApprovals}*\n\n`;

    text += `━━━━━━━━━━━━━━━━━━━━━\n`;
    text += `Have a productive day! 🚀`;

    return {
      date: dateStr,
      metrics: {
        totalLeads,
        qualifiedLeads,
        demosScheduled,
        activeStudents,
        healthDistribution: { green, yellow, red },
        aiActionsToday: todayAiLogs.length,
        exceptionsCount,
      },
      briefingText: text,
    };
  }

  /**
   * Dispatches the morning briefing to the founder on WhatsApp
   */
  async sendBriefingToFounder(toPhone?: string): Promise<{ success: boolean; preview: string }> {
    const briefing = await this.generateDailyBriefing();
    const founderPhone = toPhone || process.env.FOUNDER_WHATSAPP_NUMBER;
    // Superadmins also get the briefing by email (not when a specific phone was requested, e.g. a test send)
    const superadmins = !toPhone && isEmailEnabled()
      ? await prisma.user.findMany({ where: { role: 'superadmin', isActive: true }, select: { id: true, email: true, phone: true } })
      : [];
    if (!founderPhone && superadmins.length === 0) {
      throw new Error('No founder WhatsApp number or superadmin email: pass toPhone or set FOUNDER_WHATSAPP_NUMBER');
    }

    if (founderPhone) {
      await enqueueWhatsApp({ to: founderPhone, text: briefing.briefingText, agentId: 'ChiefOfStaffAI' });
    }
    const plain = briefing.briefingText.replace(/\*/g, '').replace(/[━─]{3,}/g, '').replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '');
    for (const u of superadmins) {
      await notifyUser({
        user: { id: u.id, email: u.email, phone: null },
        agentId: 'ChiefOfStaffAI',
        email: {
          kind: 'system',
          subject: `E-Kalavya daily briefing: ${briefing.date}`,
          title: `Daily briefing: ${briefing.date}`,
          paragraphs: plain.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean),
        },
        idempotencyKey: `briefing-${briefing.date}-${u.id}`,
      });
    }

    await aiActivityLogService.log({
      agentId: 'ChiefOfStaffAI',
      actionType: 'founder_briefing_dispatched',
      payload: { to: founderPhone ?? null, emails: superadmins.length, metrics: briefing.metrics },
      status: 'success',
    });

    logger.info(`ChiefOfStaffAI morning briefing dispatched to founder at ${founderPhone}`);
    return { success: true, preview: briefing.briefingText };
  }

  /**
   * Scans system for operational exceptions
   */
  async scanExceptions(): Promise<ExceptionItem[]> {
    const exceptions: ExceptionItem[] = [];

    // 1. Scan for failed AI tool executions
    const failedLogs = await prisma.aiActivityLog.findMany({
      where: { status: 'failure' },
      orderBy: { timestamp: 'desc' },
      take: 10,
    });

    for (const log of failedLogs) {
      exceptions.push({
        id: `fail-${log.id}`,
        type: 'AI_TOOL_FAILURE',
        severity: 'HIGH',
        title: `Failed Tool Action by ${log.agentId}`,
        details: `Action '${log.actionType}' failed. Reason: ${JSON.stringify(log.payload)}`,
        targetId: log.targetId || undefined,
        timestamp: log.timestamp.toISOString(),
      });
    }

    // 1b. Exceptions flagged by ChiefOfStaffAI (flag_exception tool)
    const flagged = await prisma.aiActivityLog.findMany({
      where: { actionType: 'exception_flagged' },
      orderBy: { timestamp: 'desc' },
      take: 10,
    });
    for (const log of flagged) {
      const p = (log.payload ?? {}) as Record<string, any>;
      exceptions.push({
        id: `flag-${log.id}`,
        type: 'FLAGGED_EXCEPTION',
        severity: (['HIGH', 'MEDIUM', 'LOW'].includes(p.severity) ? p.severity : 'MEDIUM') as ExceptionItem['severity'],
        title: String(p.title ?? 'Flagged exception'),
        details: String(p.details ?? ''),
        targetId: log.targetId || undefined,
        timestamp: log.timestamp.toISOString(),
      });
    }

    // 2. Scan for critical health students
    const redStudents = await prisma.student.findMany({
      where: { status: 'active' },
      include: { academicRecords: true, parent: true },
    });

    for (const st of redStudents) {
      const records = st.academicRecords;
      if (records.length === 0) continue;
      const avg =
        records.reduce((acc, r) => acc + ((Number(r.markObtained ?? 0) / Number(r.totalMarks ?? 1)) * 100), 0) /
        records.length;

      if (avg < 50) {
        exceptions.push({
          id: `health-${st.id}`,
          type: 'CRITICAL_STUDENT_HEALTH',
          severity: 'HIGH',
          title: `Student Academic Score in Critical Zone: ${st.fullName}`,
          details: `Current average is ${Math.round(avg)}%. Attendance: ${records[0]?.attendancePercentage != null ? `${records[0].attendancePercentage}%` : 'not recorded'}. Remedial action recommended.`,
          targetId: st.id,
          timestamp: new Date().toISOString(),
        });
      }
    }

    return exceptions;
  }

  /**
   * Returns Approval rows for the HITL queue (pending by default), read from the DB
   */
  async getApprovalQueue(status: Parameters<typeof approvalService.listApprovals>[0] = 'pending') {
    return approvalService.listApprovals(status);
  }
}

export const chiefOfStaffService = new ChiefOfStaffService();
