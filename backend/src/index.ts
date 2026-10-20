import 'dotenv/config';
import app from './app';
import { logger } from './utils/logger';
import { connectRedis } from './utils/redis';
import { prisma } from './utils/database';

let whatsappWorker: { close(): Promise<void> } | null = null;
let emailWorker: { close(): Promise<void> } | null = null;

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;

async function bootstrap() {
  try {
    // Verify DB connection
    try {
      await prisma.$connect();
      logger.info('✅  PostgreSQL connected successfully');
    } catch (err: any) {
      logger.error('💥  PostgreSQL connection unavailable — the API will return errors until it is reachable', { error: err.message });
    }

    // Verify Redis connection
    try {
      await connectRedis();
      logger.info('✅  Redis connected successfully');

      // Without this worker no WhatsApp message is ever delivered.
      try {
        const { startWhatsAppWorker } = await import('./utils/queues');
        whatsappWorker = startWhatsAppWorker();
        const { startEmailWorker } = await import('./utils/email-queue');
        const { isEmailEnabled } = await import('./services/email.service');
        if (isEmailEnabled()) emailWorker = startEmailWorker();
        else logger.warn('⚠️  RESEND_API_KEY is not set — emails will NOT be sent (WhatsApp is unaffected)');
      } catch (err: any) {
        logger.error('💥  WhatsApp send worker failed to start — NO WhatsApp messages will be delivered', { error: err.message });
      }
    } catch (err: any) {
      logger.warn('⚠️  Redis connection unavailable, caching running in resilient mode', { error: err.message });
      logger.error('💥  Redis is down — the WhatsApp send worker was NOT started, so NO WhatsApp messages will be delivered until the API is restarted with Redis available');
    }

    // Start reminder scheduler if possible
    try {
      const { reminderService } = await import('./services/reminder.service');
      reminderService.startScheduler();
    } catch (err: any) {
      logger.warn('⚠️  Reminder scheduler skipped (Redis not connected)');
    }

    // Daily class-link announcements (07:30 IST + 5-minute pickup)
    try {
      const { startClassLinkScheduler } = await import('./services/class-link.service');
      startClassLinkScheduler();
    } catch (err: any) {
      logger.warn('⚠️  Class link scheduler skipped', { error: err.message });
    }

    // Weekly student reports (Saturday) and weekly teacher reminder rules
    try {
      const { startWeeklyReportScheduler } = await import('./services/weekly-report.service');
      startWeeklyReportScheduler();
      const { startReminderRuleScheduler } = await import('./services/reminder-rule.service');
      startReminderRuleScheduler();
    } catch (err: any) {
      logger.warn('⚠️  Weekly report / reminder-rule schedulers skipped', { error: err.message });
    }

    // Start HTTP server
    app.listen(PORT, () => {
      logger.info(`🚀  E-Kalavya API Gateway running on port ${PORT} [${process.env.NODE_ENV}]`);
    });
  } catch (error) {
    logger.error('💥  Failed to start server', { error });
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully...');
  await whatsappWorker?.close().catch((err: Error) => logger.error('Failed to close WhatsApp worker', { error: err.message }));
  await emailWorker?.close().catch((err: Error) => logger.error('Failed to close email worker', { error: err.message }));
  await prisma.$disconnect();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully...');
  await whatsappWorker?.close().catch((err: Error) => logger.error('Failed to close WhatsApp worker', { error: err.message }));
  await emailWorker?.close().catch((err: Error) => logger.error('Failed to close email worker', { error: err.message }));
  await prisma.$disconnect();
  process.exit(0);
});

bootstrap();
