import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { LeadStatus } from '@prisma/client';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { prisma } from '../utils/database';
import { asyncHandler } from '../utils/async-handler';
import { rolesWith } from '../utils/permissions';
import {
  HEALTH_THRESHOLDS,
  ATTENDANCE_WINDOW_DAYS,
  academicAverage,
  attendanceStats,
  blendScore,
  healthFromScore,
  istDateString,
  recordPercentage,
} from '../services/academic-monitoring.service';

// One health scale for every dashboard view (GREEN >= 70, YELLOW 50-69, RED < 50 on the blended score).
export { HEALTH_THRESHOLDS };

/** Funnel order of the 7 lead stages. */
export const LEAD_STAGES: LeadStatus[] = ['enquiry', 'contacted', 'qualified', 'demo_scheduled', 'follow_up', 'converted', 'lost'];

const router = Router();
router.use(authenticate);
router.use(authorize(...rolesWith('dashboard:view')));

const round1 = (n: number) => Math.round(n * 10) / 10;
const pct = (num: number, den: number) => (den > 0 ? round1((num / den) * 100) : null);

/** Counts for all 7 stages (zero where there are no leads), in funnel order. */
async function leadCountsByStage(): Promise<Record<LeadStatus, number>> {
  const grouped = await prisma.lead.groupBy({ by: ['status'], _count: { _all: true } });
  const counts = Object.fromEntries(LEAD_STAGES.map((s) => [s, 0])) as Record<LeadStatus, number>;
  for (const g of grouped) counts[g.status] = g._count._all;
  return counts;
}

/** UTC instant of 00:00 IST for the IST day containing `d`. */
function istDayStart(d: Date = new Date()): Date {
  return new Date(`${istDateString(d)}T00:00:00+05:30`);
}

/**
 * GET /api/v1/dashboard/kpis
 * Business KPIs for the Founder Dashboard.
 * Covers: total leads, conversion rate, active students, demos scheduled.
 */
router.get('/kpis', asyncHandler(async (_req: Request, res: Response) => {
  const [leadsByStage, activeStudents, todayActivity] = await Promise.all([
    leadCountsByStage(),
    prisma.student.count({ where: { status: 'active' } }),
    prisma.aiActivityLog.count({ where: { timestamp: { gte: istDayStart() } } }),
  ]);

  const totalLeads = Object.values(leadsByStage).reduce((a, b) => a + b, 0);
  const convertedLeads = leadsByStage.converted;
  const conversionRate = Math.round(((pct(convertedLeads, totalLeads)) ?? 0));

  res.json({
    totalLeads,
    convertedLeads,
    conversionRate: `${conversionRate}%`,
    activeStudents,
    demoScheduled: leadsByStage.demo_scheduled,
    aiActionsToday: todayActivity,
    leadsByStage,
  });
}));

/**
 * GET /api/v1/dashboard/lead-pipeline
 * Data for the Kanban board — counts per status (all 7 stages).
 */
router.get('/lead-pipeline', asyncHandler(async (_req: Request, res: Response) => {
  const byStage = await leadCountsByStage();
  const pipeline = LEAD_STAGES.map((status) => ({ status, count: byStage[status] }));
  const leads = await prisma.lead.findMany({
    where: { status: { notIn: ['converted', 'lost'] } },
    include: { parent: true },
    orderBy: { updatedAt: 'desc' },
    take: 100,
  });
  res.json({ pipeline, leads });
}));

/**
 * GET /api/v1/dashboard/student-health
 * Student Health Map (Design_Doc §5). Health is derived from real data only:
 * attendance % from the Attendance table (last 30 days) blended with the
 * AcademicRecord average, banded by HEALTH_THRESHOLDS. UNKNOWN when neither exists.
 */
router.get('/student-health', asyncHandler(async (_req: Request, res: Response) => {
  const students = await prisma.student.findMany({
    where: { status: 'active' },
    select: {
      id: true,
      fullName: true,
      status: true,
      admissionDate: true,
      parent: { select: { id: true, fullName: true } },
      academicRecords: { select: { subject: true, markObtained: true, totalMarks: true, testDate: true, createdAt: true } },
    },
    orderBy: { fullName: 'asc' },
  });
  const attendance = await attendanceStats('studentId', students.map((s) => s.id));

  const healthMap = students.map((student) => {
    const avg = academicAverage(student.academicRecords);
    const att = attendance.get(student.id)?.percentage ?? null;
    const score = blendScore(avg, att);

    const bySubject = new Map<string, number[]>();
    for (const r of student.academicRecords) {
      const p = recordPercentage(r);
      if (!r.subject || p === null) continue;
      bySubject.set(r.subject, [...(bySubject.get(r.subject) ?? []), p]);
    }
    const subjectAverages = [...bySubject.entries()]
      .map(([subject, ps]) => ({ subject, averagePercentage: Math.round(ps.reduce((a, b) => a + b, 0) / ps.length), testsCount: ps.length }))
      .sort((a, b) => a.subject.localeCompare(b.subject));

    const scored = student.academicRecords
      .filter((r) => recordPercentage(r) !== null)
      .sort((a, b) => (b.testDate ?? b.createdAt).getTime() - (a.testDate ?? a.createdAt).getTime());
    const last = scored[0];

    return {
      id: student.id,
      fullName: student.fullName,
      status: student.status,
      admissionDate: student.admissionDate,
      parent: student.parent,
      health: healthFromScore(score),
      healthScore: score === null ? null : Math.round(score),
      averagePercentage: avg === null ? null : Math.round(avg),
      attendancePercentage: att,
      attendanceWindowDays: ATTENDANCE_WINDOW_DAYS,
      subjectAverages,
      lastAssessment: last
        ? { subject: last.subject, testDate: last.testDate, percentage: Math.round(recordPercentage(last) as number) }
        : null,
    };
  });

  res.json(healthMap);
}));

/**
 * GET /api/v1/dashboard/funnel-analytics
 * Funnel metrics over the 7 lead stages (ReportingAnalyticsAI).
 * - count:   leads currently in the stage.
 * - reached: leads that got at least that far (this stage or any later non-lost stage;
 *            the first stage's base is ALL leads, lost included, since every lead entered there).
 * - conversionFromFirst: reached / reached(first stage) %.
 * - dropOffFromPrevious: (1 - reached / reached(previous stage)) %.
 * 'lost' is reported as a terminal bucket (count + share of all leads), outside the progression.
 */
router.get('/funnel-analytics', asyncHandler(async (_req: Request, res: Response) => {
  const counts = await leadCountsByStage();
  const progression = LEAD_STAGES.filter((s) => s !== 'lost');
  const totalLeads = LEAD_STAGES.reduce((a, s) => a + counts[s], 0);

  const reached = progression.map((_, i) => {
    if (i === 0) return totalLeads;
    return progression.slice(i).reduce((a, s) => a + counts[s], 0);
  });

  const stages = progression.map((stage, i) => ({
    stage,
    count: counts[stage],
    reached: reached[i],
    conversionFromFirst: pct(reached[i], reached[0]),
    dropOffFromPrevious: i === 0 ? null : (reached[i - 1] > 0 ? round1(100 - (reached[i] / reached[i - 1]) * 100) : null),
  }));

  res.json({
    totalLeads,
    stages,
    lost: { stage: 'lost', count: counts.lost, shareOfAllLeads: pct(counts.lost, totalLeads) },
    overallConversionRate: pct(counts.converted, totalLeads),
  });
}));

/**
 * GET /api/v1/dashboard/overview?days=30
 * Real aggregates for the Founder view. Nothing is estimated: revenue is null when there are no Payment rows.
 */
const OverviewQuery = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });

router.get('/overview', asyncHandler(async (req: Request, res: Response) => {
  const parsed = OverviewQuery.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() }); return; }
  const { days } = parsed.data;

  const now = new Date();
  const todayStart = istDayStart(now);
  const since = new Date(todayStart.getTime() - (days - 1) * 86400000);
  // IST week runs Monday-Sunday.
  const isoDow = (new Date(`${istDateString(now)}T00:00:00Z`).getUTCDay() + 6) % 7; // Mon=0
  const weekStart = new Date(todayStart.getTime() - isoDow * 86400000);
  const weekEnd = new Date(weekStart.getTime() + 7 * 86400000);

  const [bySource, perDayRows, windowLeads, windowConverted, demosThisWeek, activeStudents, paymentAgg, batches] = await Promise.all([
    prisma.lead.groupBy({ by: ['source'], where: { createdAt: { gte: since } }, _count: { _all: true } }),
    prisma.$queryRaw<{ day: string; count: number }[]>`
      SELECT to_char(created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS day, count(*)::int AS count
      FROM leads WHERE created_at >= ${since} GROUP BY 1`,
    prisma.lead.count({ where: { createdAt: { gte: since } } }),
    prisma.lead.count({ where: { createdAt: { gte: since }, status: 'converted' } }),
    prisma.appointment.count({ where: { scheduledAt: { gte: weekStart, lt: weekEnd }, status: { not: 'cancelled' } } }),
    prisma.student.count({ where: { status: 'active' } }),
    prisma.payment.aggregate({ where: { paidAt: { gte: since } }, _sum: { amount: true }, _count: { _all: true } }),
    prisma.batch.findMany({
      select: {
        id: true,
        batchName: true,
        course: { select: { courseName: true } },
        teacher: { select: { id: true, fullName: true } },
        enrollments: {
          select: { student: { select: { id: true, status: true, academicRecords: { select: { markObtained: true, totalMarks: true } } } } },
        },
      },
      orderBy: { batchName: 'asc' },
    }),
  ]);

  const perDayMap = new Map(perDayRows.map((r) => [r.day, Number(r.count)]));
  const newLeadsPerDay = Array.from({ length: days }, (_, i) => {
    const date = istDateString(new Date(since.getTime() + i * 86400000));
    return { date, count: perDayMap.get(date) ?? 0 };
  });

  const batchIds = batches.map((b) => b.id);
  const batchAttendance = await attendanceStats('batchId', batchIds, ATTENDANCE_WINDOW_DAYS);

  const batchTable = batches.map((b) => {
    const students = b.enrollments.map((e) => e.student).filter((s) => s.status === 'active');
    const allRecords = students.flatMap((s) => s.academicRecords);
    const avg = academicAverage(allRecords);
    const att = batchAttendance.get(b.id)?.percentage ?? null;
    const score = blendScore(avg, att);
    return {
      batchId: b.id,
      batch: b.batchName,
      course: b.course.courseName,
      teacher: b.teacher ? { id: b.teacher.id, name: b.teacher.fullName } : null,
      students: students.length,
      avgScore: avg === null ? null : Math.round(avg),
      attendance: att,
      health: healthFromScore(score),
    };
  });

  res.json({
    days,
    timezone: 'Asia/Kolkata',
    since: since.toISOString(),
    leads: {
      total: windowLeads,
      bySource: bySource.map((g) => ({ source: g.source ?? 'Unknown', count: g._count._all })),
      newLeadsPerDay,
    },
    demosThisWeek,
    conversionRate: pct(windowConverted, windowLeads),
    activeStudents,
    revenue: paymentAgg._count._all > 0 ? Number(paymentAgg._sum.amount) : null,
    batches: batchTable,
    healthThresholds: HEALTH_THRESHOLDS,
  });
}));

/**
 * GET /api/v1/dashboard/academic-analytics
 * Aggregated academic metrics across batches and subjects (ReportingAnalyticsAI).
 */
router.get('/academic-analytics', asyncHandler(async (_req: Request, res: Response) => {
  const [batches, records] = await Promise.all([
    prisma.batch.findMany({
      include: {
        course: true,
        enrollments: {
          include: {
            student: {
              include: { academicRecords: true },
            },
          },
        },
      },
    }),
    prisma.academicRecord.findMany(),
  ]);

  // Aggregate batch performance
  const batchStats = batches.map((batch) => {
    const students = batch.enrollments.map((e) => e.student);
    let totalMarksPct = 0;
    let recordsCount = 0;
    let greenCount = 0;
    let yellowCount = 0;
    let redCount = 0;

    for (const student of students) {
      const stAvg = academicAverage(student.academicRecords);
      if (stAvg === null) continue;

      totalMarksPct += stAvg;
      recordsCount++;

      const band = healthFromScore(stAvg);
      if (band === 'GREEN') greenCount++;
      else if (band === 'YELLOW') yellowCount++;
      else redCount++;
    }

    const batchAvg = recordsCount > 0 ? Math.round(totalMarksPct / recordsCount) : null;
    return {
      batchId: batch.id,
      batchName: batch.batchName,
      courseTitle: batch.course.courseName,
      studentCount: students.length,
      averagePercentage: batchAvg,
      cohorts: { green: greenCount, yellow: yellowCount, red: redCount },
    };
  });

  // Aggregate subject difficulty
  const subjectMap = new Map<string, { totalPct: number; count: number }>();
  for (const r of records) {
    if (!r.subject || !r.totalMarks || Number(r.totalMarks) === 0) continue;
    const pct = (Number(r.markObtained ?? 0) / Number(r.totalMarks)) * 100;
    const existing = subjectMap.get(r.subject) || { totalPct: 0, count: 0 };
    existing.totalPct += pct;
    existing.count += 1;
    subjectMap.set(r.subject, existing);
  }

  const subjectRankings = Array.from(subjectMap.entries())
    .map(([subject, data]) => ({
      subject,
      averagePercentage: Math.round(data.totalPct / data.count),
      testsCount: data.count,
    }))
    .sort((a, b) => a.averagePercentage - b.averagePercentage); // Hardest first

  res.json({
    batchStats,
    subjectRankings,
    totalRecordsAnalyzed: records.length,
  });
}));

export default router;

