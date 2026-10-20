import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { aiActivityLogService } from './ai-activity-log.service';
import { notifyParent, delivered } from './notify.service';

type ReminderKind = 'demo_reminder_24h' | 'demo_reminder_1h';

export interface ReminderScanResult {
  sent24h: number;
  sent1h: number;
  failed: number;
  skippedOptedOut: number;
}

const AGENT_ID = 'DemoCoordinatorAI';

function formatIst(date: Date) {
  const timeStr = date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
  const dateStr = date.toLocaleDateString('en-IN', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'Asia/Kolkata' });
  return { timeStr: `${timeStr} IST`, dateStr };
}

export class ReminderService {
  /**
   * Check upcoming demo appointments and send 24h & 1h WhatsApp reminders
   * Automated Demo Coordinator AI logic (PRD §4.1, Dev_Plan Phase 2)
   * Reminders are de-duplicated per appointment (log targetId = appointment id).
   */
  async processDemoReminders(): Promise<ReminderScanResult> {
    logger.info('DemoCoordinatorAI scanning upcoming demo appointments for reminders...');
    const now = new Date();
    const result: ReminderScanResult = { sent24h: 0, sent1h: 0, failed: 0, skippedOptedOut: 0 };

    // 24-hour reminders: appointments in the 23h to 25h window
    result.sent24h = await this.sendWindow(
      'demo_reminder_24h',
      new Date(now.getTime() + 23 * 3600 * 1000),
      new Date(now.getTime() + 25 * 3600 * 1000),
      result,
    );

    // 1-hour reminders: appointments in the 45m to 75m window
    result.sent1h = await this.sendWindow(
      'demo_reminder_1h',
      new Date(now.getTime() + 45 * 60 * 1000),
      new Date(now.getTime() + 75 * 60 * 1000),
      result,
    );

    logger.info(`DemoCoordinatorAI reminder scan finished. Sent 24h: ${result.sent24h}, 1h: ${result.sent1h}, failed: ${result.failed}, opted-out skipped: ${result.skippedOptedOut}`);
    return result;
  }

  private buildMessage(kind: ReminderKind, parentName: string, scheduledAt: Date): string {
    const { timeStr, dateStr } = formatIst(scheduledAt);
    if (kind === 'demo_reminder_24h') {
      return `Namaste ${parentName || 'Parent'}! 🙏\n\nThis is a gentle reminder from E-Kalavya that your child's 1-on-1 Demo Class is scheduled for tomorrow, ${dateStr} at ${timeStr}.\n\nPlease ensure you have a quiet room, a laptop or phone, and a notebook ready. Reply "CONFIRM" to confirm your attendance, or let us know if you need to reschedule!`;
    }
    return `⏰ Starting in 1 Hour!\n\nYour child's E-Kalavya Demo Class starts today at ${timeStr}. Your teacher will share the Microsoft Teams link with you shortly.\n\nSee you in class!`;
  }

  private async sendWindow(kind: ReminderKind, from: Date, to: Date, result: ReminderScanResult): Promise<number> {
    const appointments = await prisma.appointment.findMany({
      where: { status: 'scheduled', scheduledAt: { gte: from, lte: to } },
      include: { lead: { include: { parent: true } } },
    });

    let sent = 0;
    for (const appt of appointments) {
      const parent = appt.lead.parent;
      if (!parent) continue;
      if (parent.optedOut) {
        result.skippedOptedOut++;
        continue;
      }

      // Already successfully reminded for THIS appointment?
      const alreadySent = await prisma.aiActivityLog.findFirst({
        where: { agentId: AGENT_ID, targetId: appt.id, actionType: kind, status: 'success' },
        select: { id: true },
      });
      if (alreadySent) continue;

      const text = this.buildMessage(kind, parent.fullName, new Date(appt.scheduledAt));
      const { timeStr, dateStr } = formatIst(new Date(appt.scheduledAt));
      const outcome = await notifyParent({
        parent,
        leadId: appt.leadId,
        agentId: AGENT_ID,
        targetId: appt.id,
        whatsapp: text,
        email: {
          kind: 'general',
          subject: kind === 'demo_reminder_24h' ? `Reminder: your demo class is tomorrow at ${timeStr}` : `Your demo class starts in 1 hour (${timeStr})`,
          title: kind === 'demo_reminder_24h' ? 'Your demo class is tomorrow' : 'Your demo class starts soon',
          paragraphs: text.replace(/[⏰🙏]/gu, '').split(/\n{2,}/).map((x) => x.trim()).filter(Boolean),
          details: [['Date', dateStr], ['Time', `${timeStr} IST`]],
        },
        idempotencyKey: `${kind}-${appt.id}`,
      });
      if (!delivered(outcome)) {
        result.failed++;
        const message = outcome.whatsapp === 'failed' || outcome.email === 'failed' ? 'could not queue the reminder' : 'no deliverable channel';
        logger.error(`Failed to send ${kind} for appointment ${appt.id}`, { message });
        await aiActivityLogService.log({
          agentId: AGENT_ID,
          targetId: appt.id,
          actionType: kind,
          payload: { appointmentId: appt.id, leadId: appt.leadId, scheduledAt: appt.scheduledAt, error: message },
          status: 'failure',
        });
        continue;
      }

      await aiActivityLogService.log({
        agentId: AGENT_ID,
        targetId: appt.id,
        actionType: kind,
        payload: { appointmentId: appt.id, leadId: appt.leadId, scheduledAt: appt.scheduledAt, to: parent.whatsappNumber },
        status: 'success',
      });
      sent++;
    }
    return sent;
  }

  /**
   * Start recurring background interval for reminders
   */
  startScheduler(intervalMinutes = 15): NodeJS.Timeout {
    logger.info(`Starting DemoCoordinatorAI reminder scheduler (every ${intervalMinutes} mins)`);
    // Run initial scan after 5 seconds
    setTimeout(() => {
      this.processDemoReminders().catch((err) =>
        logger.error('Error during initial demo reminder scan', { err })
      );
    }, 5000);

    return setInterval(() => {
      this.processDemoReminders().catch((err) =>
        logger.error('Error during recurring demo reminder scan', { err })
      );
    }, intervalMinutes * 60 * 1000);
  }
}

export const reminderService = new ReminderService();
