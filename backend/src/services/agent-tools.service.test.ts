import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { prisma } from '../utils/database';

vi.mock('../utils/queues', async (orig) => ({
  ...(await orig<typeof import('../utils/queues')>()),
  enqueueWhatsApp: vi.fn(async () => undefined),
}));

import { enqueueWhatsApp } from '../utils/queues';
import { agentToolsService } from './agent-tools.service';

const sfx = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const parentIds: string[] = [];
const leadIds: string[] = [];
const approvalIds: string[] = [];
const studentIds: string[] = [];

async function mk(optedOut = false) {
  const p = await prisma.parent.create({
    data: { fullName: `ToolTest ${sfx}`, whatsappNumber: `7${sfx}${parentIds.length}`.slice(0, 20), optedOut },
  });
  parentIds.push(p.id);
  const l = await prisma.lead.create({ data: { parentId: p.id } });
  leadIds.push(l.id);
  return { parent: p, lead: l };
}

let main: Awaited<ReturnType<typeof mk>>;

beforeAll(async () => {
  main = await mk();
});

afterAll(async () => {
  await prisma.aiActivityLog.deleteMany({ where: { OR: [{ targetId: { in: [...leadIds, ...studentIds, ...parentIds] } }, { actionType: 'exception_flagged', payload: { path: ['title'], equals: `Test flag ${sfx}` } }] } });
  await prisma.approval.deleteMany({ where: { targetId: { in: leadIds } } });
  await prisma.appointment.deleteMany({ where: { leadId: { in: leadIds } } });
  await prisma.message.deleteMany({ where: { OR: [{ leadId: { in: leadIds } }, { parentId: { in: parentIds } }] } });
  await prisma.academicRecord.deleteMany({ where: { studentId: { in: studentIds } } });
  await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
  await prisma.lead.deleteMany({ where: { id: { in: leadIds } } });
  await prisma.parent.deleteMany({ where: { id: { in: parentIds } } });
});

describe('agent permissions', () => {
  it('AdmissionsAI cannot book_demo but can hand off; DemoCoordinatorAI books', async () => {
    expect(agentToolsService.isToolAllowed('AdmissionsAI', 'book_demo')).toBe(false);
    expect(agentToolsService.isToolAllowed('AdmissionsAI', 'handoff_to_demo_coordinator')).toBe(true);
    expect(agentToolsService.isToolAllowed('DemoCoordinatorAI', 'book_demo')).toBe(true);
    expect(agentToolsService.isToolAllowed('DemoCoordinatorAI', 'handoff_to_demo_coordinator')).toBe(false);
    await expect(
      agentToolsService.executeTool('AdmissionsAI', 'book_demo', { leadId: main.lead.id, scheduledAt: new Date(Date.now() + 86400000).toISOString() })
    ).rejects.toThrow(/Permission denied/);
  });

  it('every tool definition shown to an agent is allowed for it, and the four newer agents have scoped tools', () => {
    for (const a of ['AdmissionsAI', 'DemoCoordinatorAI', 'AcademicMonitoringAI', 'ParentEngagementAI', 'ReportingAnalyticsAI', 'ChiefOfStaffAI']) {
      const defs = agentToolsService.getToolDefinitions(a);
      expect(defs.length).toBeGreaterThan(0);
      defs.forEach((d) => expect(agentToolsService.isToolAllowed(a, d.name)).toBe(true));
    }
    expect(agentToolsService.getToolDefinitions('AdmissionsAI').map((d) => d.name)).toEqual(
      expect.arrayContaining(['create_lead', 'list_leads', 'get_parent', 'handoff_to_demo_coordinator'])
    );
    expect(agentToolsService.isToolAllowed('ReportingAnalyticsAI', 'send_whatsapp_message')).toBe(false);
    expect(agentToolsService.isToolAllowed('AcademicMonitoringAI', 'get_lead')).toBe(false);
    expect(agentToolsService.isToolAllowed('ChiefOfStaffAI', 'update_lead_status')).toBe(false);
  });
});

describe('tools', () => {
  it('update_lead_status lost files an approval and does not change the lead', async () => {
    const res = await agentToolsService.executeTool('AdmissionsAI', 'update_lead_status', { leadId: main.lead.id, status: 'lost' });
    expect(res.pendingApproval).toBe(true);
    approvalIds.push(res.approvalId);
    expect((await prisma.lead.findUnique({ where: { id: main.lead.id } }))!.status).toBe('enquiry');
    const again = await agentToolsService.executeTool('AdmissionsAI', 'update_lead_status', { leadId: main.lead.id, status: 'lost' });
    expect(again.approvalId).toBe(res.approvalId); // no duplicate pending rows
  });

  it('handoff then book_demo by the coordinator, with conflict and past-date checks', async () => {
    const { lead } = await mk();
    const h = await agentToolsService.executeTool('AdmissionsAI', 'handoff_to_demo_coordinator', { leadId: lead.id });
    expect(h.handedOff).toBe(true);
    expect((await prisma.lead.findUnique({ where: { id: lead.id } }))!.assignedAgentId).toBe('DemoCoordinatorAI');

    const cal = await agentToolsService.executeTool('DemoCoordinatorAI', 'check_calendar', { date: '2099-01-05' });
    expect(cal.availableSlots).toHaveLength(6);
    expect(cal.availableSlots[0].iso).toBe('2099-01-05T04:30:00.000Z'); // 10:00 IST

    const appt = await agentToolsService.executeTool('DemoCoordinatorAI', 'book_demo', { leadId: lead.id, scheduledAt: cal.availableSlots[0].iso });
    expect(appt.status).toBe('scheduled');
    expect((await prisma.lead.findUnique({ where: { id: lead.id } }))!.status).toBe('demo_scheduled');

    const other = await mk();
    await expect(
      agentToolsService.executeTool('DemoCoordinatorAI', 'book_demo', { leadId: other.lead.id, scheduledAt: cal.availableSlots[0].iso })
    ).rejects.toThrow(/already booked/);
    await expect(
      agentToolsService.executeTool('DemoCoordinatorAI', 'book_demo', { leadId: other.lead.id, scheduledAt: '2020-01-01T00:00:00.000Z' })
    ).rejects.toThrow(/future/);
    const after = await agentToolsService.executeTool('DemoCoordinatorAI', 'check_calendar', { date: '2099-01-05' });
    expect(after.availableSlots).toHaveLength(5);
  });

  it('rejects invalid arguments with a readable message', async () => {
    await expect(agentToolsService.executeTool('AdmissionsAI', 'qualify_lead', { leadId: 'nope' })).rejects.toThrow(/Invalid arguments/);
  });

  it('refuses leads outside the conversation scope', async () => {
    const other = await mk();
    await expect(
      agentToolsService.executeTool('AdmissionsAI', 'get_lead', { leadId: other.lead.id }, { leadId: main.lead.id })
    ).rejects.toThrow(/Out of scope/);
  });

  it('send_whatsapp_message resolves the number from the lead, ignores/never accepts raw numbers, and caps at 3 per 24h', async () => {
    const { lead, parent } = await mk();
    vi.mocked(enqueueWhatsApp).mockClear();
    await expect(
      agentToolsService.executeTool('AdmissionsAI', 'send_whatsapp_message', { to: '919999999999', text: 'hi' })
    ).rejects.toThrow(/leadId or parentId/);

    for (let i = 0; i < 3; i++) {
      const r = await agentToolsService.executeTool('AdmissionsAI', 'send_whatsapp_message', { leadId: lead.id, to: '919999999999', text: `msg ${i}` });
      expect(r.success).toBe(true);
    }
    expect(enqueueWhatsApp).toHaveBeenCalledTimes(3);
    expect(vi.mocked(enqueueWhatsApp).mock.calls.every(([job]) => job.to === parent.whatsappNumber)).toBe(true);
    await expect(
      agentToolsService.executeTool('AdmissionsAI', 'send_whatsapp_message', { leadId: lead.id, text: 'fourth' })
    ).rejects.toThrow(/max 3/);
    expect(enqueueWhatsApp).toHaveBeenCalledTimes(3);
  });

  it('send_whatsapp_message refuses opted-out parents', async () => {
    const { lead } = await mk(true);
    await expect(
      agentToolsService.executeTool('AdmissionsAI', 'send_whatsapp_message', { leadId: lead.id, text: 'hello' })
    ).rejects.toThrow(/opted out/);
  });

  it('send_progress_report respects optedOut', async () => {
    const { parent } = await mk(true);
    const st = await prisma.student.create({ data: { parentId: parent.id, fullName: `Opt ${sfx}` } });
    studentIds.push(st.id);
    await expect(agentToolsService.executeTool('ParentEngagementAI', 'send_progress_report', { studentId: st.id })).rejects.toThrow(/opted out/);
  });

  it('academic tools are read-only views over real rows', async () => {
    const st = await prisma.student.create({ data: { parentId: main.parent.id, fullName: `Acad ${sfx}` } });
    studentIds.push(st.id);
    const empty = await agentToolsService.executeTool('AcademicMonitoringAI', 'get_student_summary', { studentId: st.id });
    expect(empty.hasRecords).toBe(false);
    await prisma.academicRecord.create({ data: { studentId: st.id, subject: 'Maths', markObtained: 40, totalMarks: 100 } });
    const recs = await agentToolsService.executeTool('AcademicMonitoringAI', 'get_student_records', { studentId: st.id });
    expect(recs).toHaveLength(1);
    const sum = await agentToolsService.executeTool('AcademicMonitoringAI', 'get_student_summary', { studentId: st.id });
    expect(sum.hasRecords).toBe(true);
  });

  it('funnel, agent status, activity logs and flag_exception work on real data', async () => {
    const f = await agentToolsService.executeTool('ReportingAnalyticsAI', 'get_funnel_metrics', {});
    expect(f.totalLeads).toBeGreaterThanOrEqual(1);
    const s = await agentToolsService.executeTool('ChiefOfStaffAI', 'get_agent_status', { agentId: 'AdmissionsAI' });
    expect(s[0].agentId).toBe('AdmissionsAI');
    const logs = await agentToolsService.executeTool('ChiefOfStaffAI', 'get_activity_logs', { limit: 5 });
    expect(typeof logs[0].id).toBe('string'); // BigInt made JSON-safe
    const fl = await agentToolsService.executeTool('ChiefOfStaffAI', 'flag_exception', { title: `Test flag ${sfx}`, details: 'x', severity: 'LOW' });
    expect(fl.flagged).toBe(true);
  });

  it('deterministic variant tags the audit row', async () => {
    await agentToolsService.executeTool('AdmissionsAI', 'get_lead', { leadId: main.lead.id }, { variant: 'deterministic' });
    const row = await prisma.aiActivityLog.findFirst({ where: { targetId: main.lead.id, actionType: 'tool_get_lead_deterministic' } });
    expect(row).toBeTruthy();
  });
});
