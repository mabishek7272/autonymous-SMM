import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { aiActivityLogService } from './ai-activity-log.service';
import { approvalService } from './approval.service';
import { academicMonitoringService } from './academic-monitoring.service';
import { parentEngagementService } from './parent-engagement.service';
import { enqueueWhatsApp } from '../utils/queues';
import { normalizePhone } from '../utils/phone';
import { z } from 'zod';
import { LeadStatus, LeadSource, AppointmentStatus } from '@prisma/client';

// ── Agent Tool Permissions Map (Security_Plan.md §3.1) ──────────
// Mirrors agents/<slug>/employee.json. Booking belongs to DemoCoordinatorAI only;
// AdmissionsAI hands the lead over with handoff_to_demo_coordinator.
const AGENT_PERMISSIONS: Record<string, { allowed: string[]; denied: string[] }> = {
  AdmissionsAI: {
    allowed: [
      'create_lead',
      'qualify_lead',
      'update_lead_status',
      'get_lead',
      'list_leads',
      'send_whatsapp_message',
      'get_parent',
      'check_calendar',
      'handoff_to_demo_coordinator',
    ],
    denied: [
      'book_demo',
      'create_student',
      'update_academic_record',
      'get_teacher_salary',
      'delete_student',
      'approve_payment',
    ],
  },
  DemoCoordinatorAI: {
    allowed: [
      'check_calendar',
      'book_demo',
      'update_lead_status',
      'get_lead',
      'list_leads',
      'send_whatsapp_message',
      'get_parent',
    ],
    denied: [
      'create_student',
      'update_academic_record',
      'delete_student',
      'approve_payment',
    ],
  },
  AcademicMonitoringAI: {
    allowed: ['get_student_summary', 'get_student_records'],
    denied: [
      'create_student',
      'update_student',
      'delete_student',
      'create_lead',
      'update_lead_status',
      'send_whatsapp_message',
      'get_teacher_salary',
      'approve_payment',
    ],
  },
  ParentEngagementAI: {
    allowed: ['get_student_summary', 'send_progress_report'],
    denied: ['update_marks', 'change_batch', 'modify_fees', 'delete_student', 'send_whatsapp_message'],
  },
  ReportingAnalyticsAI: {
    allowed: ['get_funnel_metrics'],
    denied: ['send_whatsapp_message', 'update_lead_status', 'update_academic_record', 'delete_student'],
  },
  ChiefOfStaffAI: {
    allowed: ['get_agent_status', 'get_activity_logs', 'flag_exception'],
    denied: ['update_lead_status', 'update_academic_record', 'approve_payment', 'delete_student', 'send_whatsapp_message'],
  },
};

/** Guardrail: max outbound AI messages per lead (or parent) per rolling 24h. */
export const MAX_AI_MESSAGES_PER_24H = 3;

// ── Validation Schemas ─────────────────────────────────────────

const CreateLeadArgs = z.object({
  parentId: z.string().uuid().optional(),
  parentName: z.string().min(2).optional(),
  whatsappNumber: z.string().min(8).optional(),
  source: z.nativeEnum(LeadSource).optional().default(LeadSource.Website),
  gradeInterested: z.string().optional(),
  boardInterested: z.string().optional(),
  subjectsInterested: z.array(z.string()).optional(),
  requirements: z.string().optional(),
});

const QualifyLeadArgs = z.object({
  leadId: z.string().uuid(),
  gradeInterested: z.string().min(1),
  boardInterested: z.string().min(1),
  subjectsInterested: z.array(z.string()).min(1),
  requirements: z.string().optional(),
  aiScore: z.number().int().min(0).max(100).optional(),
});

const UpdateLeadStatusArgs = z.object({
  leadId: z.string().uuid(),
  status: z.nativeEnum(LeadStatus),
});

const CheckCalendarArgs = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD').optional(),
});

const BookDemoArgs = z.object({
  leadId: z.string().uuid(),
  scheduledAt: z.string().datetime({ offset: true }),
  durationMinutes: z.number().int().min(10).max(120).default(30),
});

const HandoffArgs = z.object({
  leadId: z.string().uuid(),
  preferredSlot: z.string().datetime({ offset: true }).optional(),
  note: z.string().max(500).optional(),
});

// Recipient is always resolved from the lead/parent record; a raw phone number is never accepted.
const SendWhatsAppMessageArgs = z
  .object({
    text: z.string().min(1).max(2000),
    leadId: z.string().uuid().optional(),
    parentId: z.string().uuid().optional(),
  })
  .refine((v) => v.leadId || v.parentId, { message: 'leadId or parentId is required' });

const GetLeadArgs = z.object({ leadId: z.string().uuid() });

const GetParentArgs = z
  .object({ parentId: z.string().uuid().optional(), leadId: z.string().uuid().optional() })
  .refine((v) => v.parentId || v.leadId, { message: 'parentId or leadId is required' });

const ListLeadsArgs = z.object({
  status: z.nativeEnum(LeadStatus).optional(),
  limit: z.number().int().min(1).max(50).default(20),
});

const StudentIdArgs = z.object({ studentId: z.string().uuid() });

const StudentRecordsArgs = z.object({
  studentId: z.string().uuid(),
  limit: z.number().int().min(1).max(50).default(20),
});

const FunnelArgs = z.object({ days: z.number().int().min(1).max(365).default(30) });

const AgentStatusArgs = z.object({ agentId: z.string().max(100).optional() });

const ActivityLogsArgs = z.object({
  agentId: z.string().max(100).optional(),
  targetId: z.string().max(64).optional(),
  limit: z.number().int().min(1).max(100).default(25),
});

const FlagExceptionArgs = z.object({
  title: z.string().min(3).max(255),
  details: z.string().min(1).max(2000),
  severity: z.enum(['HIGH', 'MEDIUM', 'LOW']).default('MEDIUM'),
  targetId: z.string().max(64).optional(),
});

// ── Helpers ────────────────────────────────────────────────────

const IST_OFFSET = '+05:30';
const DEMO_SLOT_TIMES = ['10:00', '11:30', '14:00', '15:30', '17:00', '18:30'];

/** YYYY-MM-DD for the given instant as seen in Asia/Kolkata. */
function istDate(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
}

function formatZodError(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join('.') || 'args'}: ${i.message}`).join('; ');
}

function summarise(result: unknown): unknown {
  if (Array.isArray(result)) return { count: result.length };
  if (result && typeof result === 'object') return Object.keys(result as object);
  return result;
}

/** Recursively converts BigInt (ai_activity_log ids) so results are JSON-safe for the LLM and logs. */
function jsonSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

export interface ToolContext {
  /** 'deterministic' tags audit rows as written by the rule engine, not an LLM. */
  variant?: 'deterministic';
  /** Conversation scope: lead-bound tools may not act on any other lead. */
  leadId?: string;
}

// ── Agent Tools Service ────────────────────────────────────────

export class AgentToolsService {
  /**
   * Verify if an agent is permitted to execute a specific tool
   */
  isToolAllowed(agentId: string, toolName: string): boolean {
    const permissions = AGENT_PERMISSIONS[agentId];
    if (!permissions) {
      logger.warn(`Unknown agent ${agentId} attempting tool call ${toolName}`);
      return false;
    }
    if (permissions.denied.includes(toolName)) {
      return false;
    }
    return permissions.allowed.includes(toolName);
  }

  /** Throws when the conversation is bound to a lead and the tool targets another one. */
  private assertInScope(ctx: ToolContext | undefined, leadId: string | undefined): void {
    if (ctx?.leadId && leadId && leadId !== ctx.leadId) {
      throw new Error('Out of scope: this conversation may only act on its own lead');
    }
  }

  /**
   * Execute a tool on behalf of an AI agent with validation, RBAC, and audit logging.
   * Throws on permission, validation or execution failure; the LLM loop turns that
   * into a tool result so the model can recover.
   */
  async executeTool(agentId: string, toolName: string, rawArgs: Record<string, any>, ctx?: ToolContext): Promise<any> {
    const suffix = ctx?.variant === 'deterministic' ? '_deterministic' : '';
    const actionType = `tool_${toolName}${suffix}`;

    if (!this.isToolAllowed(agentId, toolName)) {
      const errorMsg = `Permission denied: ${agentId} is not allowed to execute tool '${toolName}'`;
      logger.error(errorMsg);
      await aiActivityLogService.log({
        agentId,
        actionType: `tool_${toolName}_denied${suffix}`,
        payload: { error: errorMsg, args: rawArgs },
        status: 'failure',
      });
      throw new Error(errorMsg);
    }

    // A conversation-bound call may omit leadId; fill it from scope.
    const args: Record<string, any> = { ...(rawArgs || {}) };
    if (ctx?.leadId && args.leadId === undefined && args.parentId === undefined && this.isLeadBound(toolName)) {
      args.leadId = ctx.leadId;
    }

    let targetId: string | undefined;
    try {
      let result: any;

      switch (toolName) {
        case 'create_lead': {
          const parsed = CreateLeadArgs.parse(args);
          let resolvedParentId = parsed.parentId;
          if (!resolvedParentId && parsed.whatsappNumber) {
            const phone = normalizePhone(parsed.whatsappNumber);
            if (!phone) throw new Error('whatsappNumber is not a valid phone number');
            const parent = await prisma.parent.upsert({
              where: { whatsappNumber: phone },
              update: {},
              create: {
                fullName: parsed.parentName || 'Unknown',
                whatsappNumber: phone,
              },
            });
            resolvedParentId = parent.id;
          }

          if (!resolvedParentId) {
            throw new Error('Could not resolve or create parent for lead');
          }

          result = await prisma.lead.create({
            data: {
              parentId: resolvedParentId,
              source: parsed.source,
              gradeInterested: parsed.gradeInterested,
              boardInterested: parsed.boardInterested,
              subjectsInterested: parsed.subjectsInterested || [],
              requirements: parsed.requirements,
              assignedAgentId: agentId,
              status: 'enquiry',
            },
            include: { parent: true },
          });
          targetId = result.id;
          break;
        }

        case 'qualify_lead': {
          const parsed = QualifyLeadArgs.parse(args);
          this.assertInScope(ctx, parsed.leadId);
          targetId = parsed.leadId;
          result = await prisma.lead.update({
            where: { id: parsed.leadId },
            data: {
              status: 'qualified',
              gradeInterested: parsed.gradeInterested,
              boardInterested: parsed.boardInterested,
              subjectsInterested: parsed.subjectsInterested,
              requirements: parsed.requirements,
              aiScore: parsed.aiScore,
              assignedAgentId: agentId,
            },
            include: { parent: true },
          });
          break;
        }

        case 'update_lead_status': {
          const parsed = UpdateLeadStatusArgs.parse(args);
          this.assertInScope(ctx, parsed.leadId);
          targetId = parsed.leadId;

          if (parsed.status === 'lost') {
            // Guarded action: agents never mark a lead lost on their own.
            const lead = await prisma.lead.findUnique({ where: { id: parsed.leadId }, include: { parent: true } });
            if (!lead) throw new Error(`Lead ${parsed.leadId} not found`);
            const approval =
              (await approvalService.findPending('lead.mark_lost', lead.id)) ??
              (await approvalService.requestApproval({
                agentId,
                actionType: 'lead.mark_lost',
                title: `Mark lead ${lead.parent.fullName} as lost`,
                reason: `Requested by ${agentId}`,
                payload: { leadId: lead.id, previousStatus: lead.status },
                targetId: lead.id,
                risk: 'medium',
              }));
            result = {
              pendingApproval: true,
              approvalId: approval.id,
              message: 'Marking a lead as lost needs human approval. The request is pending; the lead status has NOT changed.',
            };
            break;
          }

          result = await prisma.lead.update({
            where: { id: parsed.leadId },
            data: { status: parsed.status },
          });
          break;
        }

        case 'check_calendar': {
          const parsed = CheckCalendarArgs.parse(args);
          // Slots are Asia/Kolkata wall-clock times; default to tomorrow (IST).
          const dateStr = parsed.date || istDate(new Date(Date.now() + 86400000));
          const dayStart = new Date(`${dateStr}T00:00:00${IST_OFFSET}`);
          if (Number.isNaN(dayStart.getTime())) throw new Error(`Invalid date '${dateStr}'`);
          const dayEnd = new Date(dayStart.getTime() + 86400000);

          const booked = await prisma.appointment.findMany({
            where: {
              scheduledAt: { gte: dayStart, lt: dayEnd },
              status: { in: ['scheduled', 'completed'] },
            },
            select: { scheduledAt: true },
          });
          const bookedMs = new Set(booked.map((b) => b.scheduledAt.getTime()));
          const now = Date.now();

          const availableSlots = DEMO_SLOT_TIMES
            .map((t) => ({ time: t, at: new Date(`${dateStr}T${t}:00${IST_OFFSET}`) }))
            .filter((s) => !bookedMs.has(s.at.getTime()) && s.at.getTime() > now)
            .map((s) => ({ time: s.time, iso: s.at.toISOString(), formatted: `${s.time} IST` }));

          result = { date: dateStr, timezone: 'Asia/Kolkata', availableSlots, totalBooked: booked.length };
          break;
        }

        case 'book_demo': {
          const parsed = BookDemoArgs.parse(args);
          this.assertInScope(ctx, parsed.leadId);
          targetId = parsed.leadId;
          const when = new Date(parsed.scheduledAt);
          if (when.getTime() <= Date.now()) throw new Error('scheduledAt must be in the future');

          result = await prisma.$transaction(async (tx) => {
            // Serialise bookings so two concurrent calls cannot take the same slot.
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('demo_slot_booking'))`;
            const lead = await tx.lead.findUnique({ where: { id: parsed.leadId } });
            if (!lead) throw new Error(`Lead ${parsed.leadId} not found`);
            const clash = await tx.appointment.findFirst({
              where: { scheduledAt: when, status: { in: ['scheduled', 'completed'] } },
              select: { id: true },
            });
            if (clash) throw new Error('That slot is already booked; call check_calendar for open slots');
            const appointment = await tx.appointment.create({
              data: {
                leadId: parsed.leadId,
                scheduledAt: when,
                durationMinutes: parsed.durationMinutes,
                status: AppointmentStatus.scheduled,
              },
            });
            await tx.lead.update({ where: { id: parsed.leadId }, data: { status: 'demo_scheduled' } });
            return appointment;
          });
          break;
        }

        case 'handoff_to_demo_coordinator': {
          const parsed = HandoffArgs.parse(args);
          this.assertInScope(ctx, parsed.leadId);
          targetId = parsed.leadId;
          const lead = await prisma.lead.findUnique({ where: { id: parsed.leadId } });
          if (!lead) throw new Error(`Lead ${parsed.leadId} not found`);
          await prisma.lead.update({ where: { id: parsed.leadId }, data: { assignedAgentId: 'DemoCoordinatorAI' } });
          result = {
            handedOff: true,
            to: 'DemoCoordinatorAI',
            leadId: parsed.leadId,
            preferredSlot: parsed.preferredSlot ?? null,
            note: parsed.note ?? null,
            message: 'DemoCoordinatorAI now owns this lead and will confirm the booking. No demo is booked yet.',
          };
          break;
        }

        case 'send_whatsapp_message': {
          const parsed = SendWhatsAppMessageArgs.parse(args);
          this.assertInScope(ctx, parsed.leadId);
          const scopedLeadId = parsed.leadId ?? ctx?.leadId;

          // Resolve the recipient from the record; never trust a phone number from the model.
          let lead: { id: string; parentId: string } | null = null;
          let parent: { id: string; whatsappNumber: string; optedOut: boolean } | null = null;
          if (scopedLeadId) {
            const l = await prisma.lead.findUnique({ where: { id: scopedLeadId }, include: { parent: true } });
            if (!l) throw new Error(`Lead ${scopedLeadId} not found`);
            lead = l;
            parent = l.parent;
            if (parsed.parentId && parsed.parentId !== l.parentId) {
              throw new Error('parentId does not belong to that lead');
            }
          } else {
            parent = await prisma.parent.findUnique({ where: { id: parsed.parentId! } });
            if (!parent) throw new Error(`Parent ${parsed.parentId} not found`);
          }
          targetId = lead?.id ?? parent.id;
          if (parent.optedOut) throw new Error('Recipient has opted out of messages');

          const since = new Date(Date.now() - 24 * 3600 * 1000);
          const scopeWhere = lead ? { leadId: lead.id } : { parentId: parent.id };

          // Count + insert under an advisory lock so concurrent calls cannot exceed the cap.
          const message = await prisma.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${targetId!}))`;
            const sent = await tx.message.count({
              where: { ...scopeWhere, direction: 'outbound', agentId: { not: null }, createdAt: { gte: since } },
            });
            if (sent >= MAX_AI_MESSAGES_PER_24H) {
              throw new Error(
                `Guardrail: max ${MAX_AI_MESSAGES_PER_24H} outbound AI messages per lead per 24h reached (${sent} sent). Do not retry; wait for the parent to reply or escalate to a human.`
              );
            }
            return tx.message.create({
              data: {
                leadId: lead?.id,
                parentId: parent!.id,
                direction: 'outbound',
                channel: 'whatsapp',
                body: parsed.text,
                status: 'queued',
                agentId,
              },
            });
          });

          try {
            await enqueueWhatsApp({ to: parent.whatsappNumber, text: parsed.text, agentId, targetId, messageId: message.id });
          } catch (err) {
            await prisma.message.update({ where: { id: message.id }, data: { status: 'failed:enqueue' } });
            throw err;
          }
          result = { success: true, status: 'queued', messageId: message.id };
          break;
        }

        case 'get_lead': {
          const parsed = GetLeadArgs.parse(args);
          this.assertInScope(ctx, parsed.leadId);
          targetId = parsed.leadId;
          result = await prisma.lead.findUnique({
            where: { id: parsed.leadId },
            include: { parent: true, appointments: true },
          });
          if (!result) throw new Error(`Lead ${parsed.leadId} not found`);
          break;
        }

        case 'list_leads': {
          const parsed = ListLeadsArgs.parse(args);
          // A parent-facing conversation must never see other families' lead data.
          if (ctx?.leadId) throw new Error('Out of scope: list_leads is not available inside a parent conversation');
          result = await prisma.lead.findMany({
            where: parsed.status ? { status: parsed.status } : {},
            include: { parent: true },
            take: parsed.limit,
            orderBy: { createdAt: 'desc' },
          });
          break;
        }

        case 'get_parent': {
          const parsed = GetParentArgs.parse(args);
          this.assertInScope(ctx, parsed.leadId);
          let parentId = parsed.parentId;
          const scopedLeadId = parsed.leadId ?? ctx?.leadId;
          if (scopedLeadId) {
            const l = await prisma.lead.findUnique({ where: { id: scopedLeadId }, select: { parentId: true } });
            if (!l) throw new Error(`Lead ${scopedLeadId} not found`);
            if (parentId && parentId !== l.parentId) throw new Error('Out of scope: parentId does not belong to this conversation');
            parentId = l.parentId;
          }
          const parent = await prisma.parent.findUnique({
            where: { id: parentId! },
            select: { id: true, fullName: true, whatsappNumber: true, email: true, optedOut: true },
          });
          if (!parent) throw new Error(`Parent ${parentId} not found`);
          targetId = parent.id;
          result = parent;
          break;
        }

        case 'get_student_summary': {
          const parsed = StudentIdArgs.parse(args);
          targetId = parsed.studentId;
          const student = await prisma.student.findUnique({
            where: { id: parsed.studentId },
            select: { id: true, fullName: true, status: true },
          });
          if (!student) throw new Error(`Student ${parsed.studentId} not found`);
          const [diagnosis, recordCount] = await Promise.all([
            academicMonitoringService.analyzeStudent(parsed.studentId),
            prisma.academicRecord.count({ where: { studentId: parsed.studentId } }),
          ]);
          // Nulls in the diagnosis mean "no data", never a default value.
          result = { student, hasRecords: recordCount > 0, recordCount, diagnosis };
          break;
        }

        case 'get_student_records': {
          const parsed = StudentRecordsArgs.parse(args);
          targetId = parsed.studentId;
          result = await prisma.academicRecord.findMany({
            where: { studentId: parsed.studentId },
            orderBy: { testDate: 'desc' },
            take: parsed.limit,
          });
          break;
        }

        case 'send_progress_report': {
          const parsed = StudentIdArgs.parse(args);
          targetId = parsed.studentId;
          const student = await prisma.student.findUnique({
            where: { id: parsed.studentId },
            include: { parent: { select: { optedOut: true } } },
          });
          if (!student) throw new Error(`Student ${parsed.studentId} not found`);
          if (student.parent.optedOut) throw new Error('Parent has opted out of messages; report not sent');
          const sent = await parentEngagementService.generateAndSendReport(parsed.studentId);
          if (!sent.success) throw new Error(sent.message || 'Progress report was not sent');
          result = { success: true, queued: true };
          break;
        }

        case 'get_funnel_metrics': {
          const parsed = FunnelArgs.parse(args);
          const since = new Date(Date.now() - parsed.days * 86400000);
          const [byStatus, bySource, demos, total] = await Promise.all([
            prisma.lead.groupBy({ by: ['status'], where: { createdAt: { gte: since } }, _count: { _all: true } }),
            prisma.lead.groupBy({ by: ['source'], where: { createdAt: { gte: since } }, _count: { _all: true } }),
            prisma.appointment.count({ where: { createdAt: { gte: since } } }),
            prisma.lead.count({ where: { createdAt: { gte: since } } }),
          ]);
          const counts: Record<string, number> = {};
          byStatus.forEach((r) => (counts[r.status] = r._count._all));
          const converted = counts.converted ?? 0;
          result = {
            windowDays: parsed.days,
            totalLeads: total,
            byStatus: counts,
            bySource: Object.fromEntries(bySource.map((r) => [r.source ?? 'unknown', r._count._all])),
            demosBooked: demos,
            conversionRatePct: total > 0 ? Math.round((converted / total) * 1000) / 10 : null,
          };
          break;
        }

        case 'get_agent_status': {
          const parsed = AgentStatusArgs.parse(args);
          const since = new Date(Date.now() - 24 * 3600 * 1000);
          const ids = parsed.agentId ? [parsed.agentId] : Object.keys(AGENT_PERMISSIONS);
          result = await Promise.all(
            ids.map(async (id) => {
              const [last, actions24h, failures24h] = await Promise.all([
                prisma.aiActivityLog.findFirst({ where: { agentId: id }, orderBy: { timestamp: 'desc' } }),
                prisma.aiActivityLog.count({ where: { agentId: id, timestamp: { gte: since } } }),
                prisma.aiActivityLog.count({ where: { agentId: id, timestamp: { gte: since }, status: 'failure' } }),
              ]);
              return { agentId: id, lastAction: last?.timestamp ?? null, actions24h, failures24h };
            })
          );
          break;
        }

        case 'get_activity_logs': {
          const parsed = ActivityLogsArgs.parse(args);
          const rows = await prisma.aiActivityLog.findMany({
            where: { agentId: parsed.agentId, targetId: parsed.targetId },
            orderBy: { timestamp: 'desc' },
            take: parsed.limit,
          });
          result = jsonSafe(rows);
          break;
        }

        case 'flag_exception': {
          const parsed = FlagExceptionArgs.parse(args);
          targetId = parsed.targetId;
          // The flag itself is the record; scanExceptions() surfaces it to the founder.
          await aiActivityLogService.log({
            agentId,
            targetId: parsed.targetId,
            actionType: 'exception_flagged',
            payload: { title: parsed.title, details: parsed.details, severity: parsed.severity },
            status: 'pending',
          });
          result = { flagged: true, severity: parsed.severity };
          break;
        }

        default:
          throw new Error(`Unimplemented tool handler for '${toolName}'`);
      }

      await aiActivityLogService.log({
        agentId,
        targetId,
        actionType,
        payload: { args, resultSummary: summarise(result) },
        status: 'success',
      });

      return result;
    } catch (error) {
      const message = error instanceof z.ZodError ? `Invalid arguments: ${formatZodError(error)}` : error instanceof Error ? error.message : String(error);
      logger.error(`Error executing tool '${toolName}' by ${agentId}: ${message}`);
      await aiActivityLogService.log({
        agentId,
        targetId,
        actionType,
        payload: { args, error: message },
        status: 'failure',
      });
      throw error instanceof z.ZodError ? new Error(`Invalid arguments: ${formatZodError(error)}`) : error;
    }
  }

  private isLeadBound(toolName: string): boolean {
    return ['qualify_lead', 'update_lead_status', 'book_demo', 'handoff_to_demo_coordinator', 'send_whatsapp_message', 'get_lead', 'get_parent'].includes(toolName);
  }

  /**
   * Get tool schemas and descriptions formatted for LLM function calling
   */
  getToolDefinitions(agentId: string) {
    const uuid = { type: 'string', description: 'UUID' };
    const definitions = [
      {
        name: 'create_lead',
        description: 'Create a new lead (and its parent record if needed) from a WhatsApp number',
        parameters: {
          type: 'object',
          properties: {
            parentId: { type: 'string', description: 'Existing parent UUID, if known' },
            parentName: { type: 'string', description: 'Parent full name' },
            whatsappNumber: { type: 'string', description: 'Parent WhatsApp number in international format' },
            source: { type: 'string', enum: Object.values(LeadSource) },
            gradeInterested: { type: 'string' },
            boardInterested: { type: 'string' },
            subjectsInterested: { type: 'array', items: { type: 'string' } },
            requirements: { type: 'string' },
          },
        },
      },
      {
        name: 'qualify_lead',
        description: 'Update the lead with collected qualification details (class, board, subjects, requirements)',
        parameters: {
          type: 'object',
          properties: {
            leadId: { type: 'string', description: 'UUID of the lead' },
            gradeInterested: { type: 'string', description: 'Student grade/class, e.g. Class 10' },
            boardInterested: { type: 'string', description: 'Educational board, e.g. CBSE, ICSE, State' },
            subjectsInterested: { type: 'array', items: { type: 'string' }, description: 'Subjects needing tutoring' },
            requirements: { type: 'string', description: 'Key challenges or goals' },
            aiScore: { type: 'integer', description: 'Lead quality score 0-100 based on how complete and keen the enquiry is' },
          },
          required: ['leadId', 'gradeInterested', 'boardInterested', 'subjectsInterested'],
        },
      },
      {
        name: 'check_calendar',
        description: 'Check open demo-class slots (IST) on a given date (YYYY-MM-DD)',
        parameters: {
          type: 'object',
          properties: {
            date: { type: 'string', description: 'Target date in YYYY-MM-DD format (defaults to tomorrow, IST)' },
          },
        },
      },
      {
        name: 'book_demo',
        description: 'Book a demo class appointment. Only succeeds if the slot is free; check the result before telling the parent it is booked',
        parameters: {
          type: 'object',
          properties: {
            leadId: { type: 'string', description: 'UUID of the lead' },
            scheduledAt: { type: 'string', description: 'ISO 8601 datetime (iso value from check_calendar)' },
            durationMinutes: { type: 'number', description: 'Duration in minutes, default 30' },
          },
          required: ['leadId', 'scheduledAt'],
        },
      },
      {
        name: 'handoff_to_demo_coordinator',
        description: 'Hand a qualified lead who wants a demo to the Demo Coordinator, who books the slot. You cannot book demos yourself',
        parameters: {
          type: 'object',
          properties: {
            leadId: { type: 'string', description: 'UUID of the lead' },
            preferredSlot: { type: 'string', description: 'ISO 8601 datetime of the slot the parent chose, if any' },
            note: { type: 'string', description: 'Context for the coordinator' },
          },
          required: ['leadId'],
        },
      },
      {
        name: 'update_lead_status',
        description: 'Update pipeline status of the lead. Setting "lost" only files a request for human approval; it does not change the lead',
        parameters: {
          type: 'object',
          properties: {
            leadId: { type: 'string', description: 'UUID of the lead' },
            status: { type: 'string', enum: Object.values(LeadStatus) },
          },
          required: ['leadId', 'status'],
        },
      },
      {
        name: 'send_whatsapp_message',
        description: 'Send an extra WhatsApp message to the parent of the lead in scope (max 3 AI messages per lead per 24h). Not needed for your normal reply',
        parameters: {
          type: 'object',
          properties: {
            leadId: { type: 'string', description: 'UUID of the lead' },
            parentId: { type: 'string', description: 'UUID of the parent (alternative to leadId)' },
            text: { type: 'string', description: 'Message body' },
          },
          required: ['text'],
        },
      },
      {
        name: 'get_lead',
        description: 'Retrieve details for a specific lead',
        parameters: {
          type: 'object',
          properties: { leadId: { type: 'string', description: 'UUID of the lead' } },
          required: ['leadId'],
        },
      },
      {
        name: 'list_leads',
        description: 'List recent leads, optionally filtered by status',
        parameters: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: Object.values(LeadStatus) },
            limit: { type: 'integer', description: 'Max rows, up to 50' },
          },
        },
      },
      {
        name: 'get_parent',
        description: 'Retrieve the parent record for a lead or parent id',
        parameters: {
          type: 'object',
          properties: { leadId: { type: 'string' }, parentId: { type: 'string' } },
        },
      },
      {
        name: 'get_student_summary',
        description: 'Academic health summary (average, attendance, weak subjects) for a student',
        parameters: { type: 'object', properties: { studentId: uuid }, required: ['studentId'] },
      },
      {
        name: 'get_student_records',
        description: 'Read-only list of a student\'s academic records, newest first',
        parameters: {
          type: 'object',
          properties: { studentId: uuid, limit: { type: 'integer', description: 'Max rows, up to 50' } },
          required: ['studentId'],
        },
      },
      {
        name: 'send_progress_report',
        description: 'Send the WhatsApp progress report for a student to their parent (skipped if the parent opted out)',
        parameters: { type: 'object', properties: { studentId: uuid }, required: ['studentId'] },
      },
      {
        name: 'get_funnel_metrics',
        description: 'Admissions funnel counts and conversion rate over the last N days',
        parameters: { type: 'object', properties: { days: { type: 'integer', description: 'Window in days, default 30' } } },
      },
      {
        name: 'get_agent_status',
        description: 'Last action time and 24h action/failure counts for one or all agents',
        parameters: { type: 'object', properties: { agentId: { type: 'string' } } },
      },
      {
        name: 'get_activity_logs',
        description: 'Recent AI activity log rows, optionally for one agent or target',
        parameters: {
          type: 'object',
          properties: { agentId: { type: 'string' }, targetId: { type: 'string' }, limit: { type: 'integer' } },
        },
      },
      {
        name: 'flag_exception',
        description: 'Flag an operational exception for the founder to review',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            details: { type: 'string' },
            severity: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'] },
            targetId: { type: 'string' },
          },
          required: ['title', 'details'],
        },
      },
    ];

    return definitions.filter((t) => this.isToolAllowed(agentId, t.name));
  }
}

export const agentToolsService = new AgentToolsService();
