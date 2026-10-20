import { Router, Request, Response } from 'express';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { aiActivityLogService } from '../services/ai-activity-log.service';
import { prisma } from '../utils/database';
import { asyncHandler } from '../utils/async-handler';
import { rolesWith } from '../utils/permissions';
import { z } from 'zod';
import { ApprovalStatus } from '@prisma/client';
import { approvalService, ApprovalError } from '../services/approval.service';

const router = Router();
router.use(authenticate);

const ActivityLogQuery = z.object({
  agentId: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const ApprovalListQuery = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'executed', 'failed', 'all']).default('pending'),
});

// Accepts APPROVED/approved and the legacy `notes` field name.
const DecisionBody = z.object({
  decision: z.string().transform((v) => v.toLowerCase()).pipe(z.enum(['approved', 'rejected'])),
  note: z.string().max(1000).optional(),
  notes: z.string().max(1000).optional(),
});

const BriefingBody = z.object({ toPhone: z.string().min(8).max(20).optional() });

/** CSV cell: neutralise spreadsheet formulas (CWE-1236), then always quote. */
function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * GET /api/v1/agents/activity-log
 * Founder/Admin view of the AI transparency log (Design_Doc.md §5 - AI Activity Log).
 */
router.get('/activity-log', authorize(...rolesWith('agents:view')), asyncHandler(async (req: Request, res: Response) => {
  const q = ActivityLogQuery.safeParse(req.query);
  if (!q.success) return void res.status(400).json({ error: 'Validation failed', details: q.error.flatten() });
  const { agentId, limit } = q.data;
  const logs = agentId
    ? await aiActivityLogService.getByAgent(agentId, limit)
    : await aiActivityLogService.getRecent(limit);
  // log ids are BigInt, which JSON cannot carry
  res.json(logs.map((l) => ({ ...l, id: l.id.toString() })));
}));

/**
 * GET /api/v1/agents/activity-log/target/:targetId
 * Get all AI actions taken on a specific lead/student/parent.
 */
router.get('/activity-log/target/:targetId', authorize(...rolesWith('agents:view')), asyncHandler(async (req: Request, res: Response) => {
  const logs = await aiActivityLogService.getByTarget(req.params.targetId);
  res.json(logs.map((l) => ({ ...l, id: l.id.toString() })));
}));

/**
 * GET /api/v1/agents/status
 * Returns a summary of registered AI agents and their recent activity.
 */
router.get('/status', authorize(...rolesWith('agents:view')), asyncHandler(async (_req: Request, res: Response) => {
  const AGENT_IDS = [
    'AdmissionsAI',
    'DemoCoordinatorAI',
    'AcademicMonitoringAI',
    'ParentEngagementAI',
    'ReportingAnalyticsAI',
    'ChiefOfStaffAI',
  ];

  const agentStatuses = await Promise.all(
    AGENT_IDS.map(async (agentId) => {
      const recent = await prisma.aiActivityLog.findFirst({
        where: { agentId },
        orderBy: { timestamp: 'desc' },
      });
      const todayCount = await prisma.aiActivityLog.count({
        where: {
          agentId,
          timestamp: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
        },
      });
      return { agentId, lastAction: recent?.timestamp ?? null, actionsToday: todayCount };
    })
  );

  res.json(agentStatuses);
}));

/**
 * POST /api/v1/agents/routines/reminders/run
 * Manually trigger DemoCoordinatorAI demo reminder routine
 */
router.post('/routines/reminders/run', authorize(...rolesWith('agents:run')), asyncHandler(async (_req: Request, res: Response) => {
  const { reminderService } = await import('../services/reminder.service');
  const result = await reminderService.processDemoReminders();
  res.json({ status: 'completed', result });
}));

/**
 * POST /api/v1/agents/routines/followup/run
 * Manually trigger AdmissionsAI daily follow-up routine
 */
router.post('/routines/followup/run', authorize(...rolesWith('agents:run')), asyncHandler(async (_req: Request, res: Response) => {
  const { hermesService } = await import('../services/hermes.service');
  const result = await hermesService.runDailyFollowup();
  res.json({ status: 'completed', result });
}));

/**
 * POST /api/v1/agents/routines/academic-monitoring/run
 * Manually trigger AcademicMonitoringAI student health evaluation scan
 */
router.post('/routines/academic-monitoring/run', authorize(...rolesWith('agents:run')), asyncHandler(async (_req: Request, res: Response) => {
  const { academicMonitoringService } = await import('../services/academic-monitoring.service');
  const result = await academicMonitoringService.scanAllStudents();
  res.json({ status: 'completed', result });
}));

/**
 * GET /api/v1/agents/founder-briefing
 * Generate real-time daily operational briefing preview
 */
router.get('/founder-briefing', authorize(...rolesWith('agents:view')), asyncHandler(async (_req: Request, res: Response) => {
  const { chiefOfStaffService } = await import('../services/chief-of-staff.service');
  const briefing = await chiefOfStaffService.generateDailyBriefing();
  res.json(briefing);
}));

/**
 * POST /api/v1/agents/routines/daily-briefing/run
 * Trigger ChiefOfStaffAI morning briefing delivery to founder via WhatsApp
 */
router.post('/routines/daily-briefing/run', authorize(...rolesWith('agents:run')), asyncHandler(async (req: Request, res: Response) => {
  const { chiefOfStaffService } = await import('../services/chief-of-staff.service');
  const body = BriefingBody.safeParse(req.body ?? {});
  if (!body.success) return void res.status(400).json({ error: 'Validation failed', details: body.error.flatten() });
  const toPhone = body.data.toPhone ?? process.env.FOUNDER_WHATSAPP_NUMBER;
  if (!toPhone) return void res.status(400).json({ error: 'No recipient: pass toPhone or set FOUNDER_WHATSAPP_NUMBER' });
  const result = await chiefOfStaffService.sendBriefingToFounder(toPhone);
  res.json({ status: 'completed', result });
}));

/**
 * POST /api/v1/agents/routines/progress-reports/run
 * Trigger ParentEngagementAI batch progress report distribution to all enrolled parents
 */
router.post('/routines/progress-reports/run', authorize(...rolesWith('agents:run')), asyncHandler(async (_req: Request, res: Response) => {
  const { parentEngagementService } = await import('../services/parent-engagement.service');
  const result = await parentEngagementService.distributeAllReports();
  res.json({ status: 'completed', result });
}));

/**
 * POST /api/v1/agents/students/:studentId/progress-report
 * Dispatch individual progress report to parent for a specific student
 */
router.post('/students/:studentId/progress-report', authorize(...rolesWith('agents:run')), asyncHandler(async (req: Request, res: Response) => {
  const { parentEngagementService } = await import('../services/parent-engagement.service');
  const studentId = z.string().uuid().safeParse(req.params.studentId);
  if (!studentId.success) return void res.status(400).json({ error: 'Invalid student id' });
  const student = await prisma.student.findUnique({ where: { id: studentId.data }, select: { parent: { select: { optedOut: true } } } });
  if (!student) return void res.status(404).json({ error: 'Student not found' });
  if (student.parent.optedOut) return void res.status(409).json({ error: 'Parent has opted out of messages; report not sent' });
  const result = await parentEngagementService.generateAndSendReport(studentId.data);
  res.json(result);
}));

/**
 * GET /api/v1/agents/exceptions
 * Scan system for operational exceptions, failed tools, and critical student flags
 */
router.get('/exceptions', authorize(...rolesWith('agents:view')), asyncHandler(async (_req: Request, res: Response) => {
  const { chiefOfStaffService } = await import('../services/chief-of-staff.service');
  const exceptions = await chiefOfStaffService.scanExceptions();
  res.json(exceptions);
}));

/**
 * GET /api/v1/agents/approval-queue?status=pending
 * Human-In-The-Loop actions from the approvals table (pending by default)
 */
router.get('/approval-queue', authorize(...rolesWith('agents:view')), asyncHandler(async (req: Request, res: Response) => {
  const q = ApprovalListQuery.safeParse(req.query);
  if (!q.success) return void res.status(400).json({ error: 'Validation failed', details: q.error.flatten() });
  const { chiefOfStaffService } = await import('../services/chief-of-staff.service');
  const items = await chiefOfStaffService.getApprovalQueue(q.data.status as ApprovalStatus | 'all');
  res.json(items);
}));

/**
 * POST /api/v1/agents/approval-queue/:id/decision
 * Decide a pending approval. Approving executes the action; high-risk items need
 * the approvals:decide_high_risk permission (checked in the service).
 */
router.post('/approval-queue/:id/decision', authorize(...rolesWith('approvals:decide')), asyncHandler(async (req: Request, res: Response) => {
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) return void res.status(400).json({ error: 'Invalid approval id' });
  const body = DecisionBody.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: 'Validation failed', details: body.error.flatten() });
  try {
    const item = await approvalService.decideApproval(id.data, body.data.decision, req.user!, body.data.note ?? body.data.notes);
    res.json({ status: item.status, item });
  } catch (err) {
    if (err instanceof ApprovalError) return void res.status(err.status).json({ error: err.message });
    throw err;
  }
}));

/**
 * GET /api/v1/agents/activity-log/export
 * Export AI audit logs as CSV for audit compliance (Security_Plan.md §5)
 */
router.get('/activity-log/export', authorize(...rolesWith('agents:view')), asyncHandler(async (_req: Request, res: Response) => {
  const logs = await prisma.aiActivityLog.findMany({
    orderBy: { timestamp: 'desc' },
    take: 1000,
  });

  const headers = ['id', 'timestamp', 'agentId', 'actionType', 'status', 'targetId', 'payload'];
  const rows = logs.map((log) =>
    [log.id, log.timestamp.toISOString(), log.agentId, log.actionType, log.status, log.targetId, JSON.stringify(log.payload ?? {})].map(csvCell)
  );

  const csvContent = [headers.map(csvCell).join(','), ...rows.map((r) => r.join(','))].join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="ekalavya_ai_activity_log.csv"');
  res.status(200).send(csvContent);
}));

export default router;

