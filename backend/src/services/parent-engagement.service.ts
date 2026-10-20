import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { aiActivityLogService } from './ai-activity-log.service';
import { academicMonitoringService } from './academic-monitoring.service';
import { notifyParent, delivered } from './notify.service';

export class ParentEngagementService {
  /**
   * Generates a structured WhatsApp academic progress report for a student
   */
  async generateAndSendReport(studentId: string): Promise<{ success: boolean; message?: string }> {
    const student = await prisma.student.findUnique({
      where: { id: studentId },
      include: {
        parent: true,
        enrollments: { include: { batch: { include: { course: true } } } },
      },
    });

    if (!student || !student.parent?.whatsappNumber) {
      return { success: false, message: 'Student or parent WhatsApp number not found' };
    }

    const diagnosis = await academicMonitoringService.analyzeStudent(studentId);
    if (!diagnosis) {
      return { success: false, message: 'No academic records available to compile report' };
    }

    const healthEmoji = diagnosis.health === 'GREEN' ? '🟢' : diagnosis.health === 'YELLOW' ? '🟡' : '🔴';
    const batchName = student.enrollments?.[0]?.batch?.batchName || 'Academic Batch';

    // Build WhatsApp formatted message
    let reportText = `📊 *E-KALAVYA ACADEMIC PROGRESS REPORT*\n`;
    reportText += `━━━━━━━━━━━━━━━━━━━━━\n`;
    reportText += `👤 *Student*: ${student.fullName}\n`;
    reportText += `🎓 *Batch*: ${batchName}\n`;
    reportText += `📈 *Overall Performance*: ${diagnosis.averagePercentage}% (${diagnosis.health} ${healthEmoji})\n`;
    reportText += `📅 *Attendance Record*: ${diagnosis.averageAttendance}%\n`;
    reportText += `━━━━━━━━━━━━━━━━━━━━━\n\n`;

    reportText += `📝 *Subject Breakdown*:\n`;
    for (const sub of diagnosis.subjectBreakdown) {
      const statusIcon = sub.status === 'STRONG' ? '⭐' : sub.status === 'WEAK' ? '⚠️' : '✓';
      reportText += `• *${sub.subject}*: ${sub.percentage}% (${sub.obtainedMarks}/${sub.totalMarks}) ${statusIcon}\n`;
    }

    if (diagnosis.weakSubjects.length > 0) {
      reportText += `\n⚠️ *Focus Areas*: Extra practice recommended in ${diagnosis.weakSubjects.join(', ')}.\n`;
    }

    reportText += `\n💡 *Teacher & AI Insights*:\n`;
    for (const rec of diagnosis.recommendations) {
      reportText += `• ${rec}\n`;
    }

    reportText += `\n━━━━━━━━━━━━━━━━━━━━━\n`;
    reportText += `Feel free to reply to this message anytime if you have questions or would like to schedule a 1-on-1 teacher consultation! 🙏`;

    // Dispatch on both channels (WhatsApp + email)
    const subjectLines = diagnosis.subjectBreakdown.map((sub) => `${sub.subject}: ${sub.percentage}% (${sub.obtainedMarks}/${sub.totalMarks})`);
    const outcome = await notifyParent({
      parent: student.parent,
      studentId: student.id,
      agentId: 'ParentEngagementAI',
      targetId: student.id,
      whatsapp: reportText,
      email: {
        kind: 'reports',
        subject: `Academic progress report: ${student.fullName}`,
        title: `Progress report for ${student.fullName}`,
        paragraphs: [
          `Overall performance is ${diagnosis.averagePercentage}% (${diagnosis.health}) with ${diagnosis.averageAttendance}% attendance.`,
          ...(diagnosis.weakSubjects.length > 0 ? [`Focus areas: extra practice is recommended in ${diagnosis.weakSubjects.join(', ')}.`] : []),
          ...diagnosis.recommendations,
        ],
        details: [['Student', student.fullName], ['Batch', batchName], ...subjectLines.map((l): [string, string] => ['Subject', l])],
        footnote: 'Reply to this email if you would like to schedule a 1-on-1 teacher consultation.',
      },
      idempotencyKey: `progress-${student.id}-${Date.now()}`,
    });
    if (student.parent.optedOut) return { success: false, message: 'Parent has opted out of messages' };
    if (!delivered(outcome)) return { success: false, message: 'Could not queue the report on any channel' };

    await aiActivityLogService.log({
      agentId: 'ParentEngagementAI',
      targetId: student.id,
      actionType: 'progress_report_sent',
      payload: {
        studentId: student.id,
        to: student.parent.whatsappNumber,
        averagePercentage: diagnosis.averagePercentage,
        health: diagnosis.health,
      },
      status: 'success',
    });

    logger.info(`ParentEngagementAI progress report dispatched for student ${student.fullName}`);
    return { success: true, message: reportText };
  }

  /**
   * Distribute monthly/weekly progress reports to all active enrolled students
   */
  async distributeAllReports(): Promise<{ totalSent: number; failures: number }> {
    logger.info('ParentEngagementAI beginning batch progress report distribution...');
    const students = await prisma.student.findMany({
      where: { status: 'active' },
      select: { id: true, fullName: true },
    });

    let totalSent = 0;
    let failures = 0;

    for (const st of students) {
      try {
        const res = await this.generateAndSendReport(st.id);
        if (res.success) totalSent++;
        else failures++;
      } catch (err) {
        logger.error(`Error sending report for student ${st.id}`, { err });
        failures++;
      }
    }

    logger.info(`ParentEngagementAI distribution complete: ${totalSent} sent, ${failures} failures`);
    return { totalSent, failures };
  }
}

export const parentEngagementService = new ParentEngagementService();
