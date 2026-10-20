import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { aiActivityLogService } from './ai-activity-log.service';

/**
 * Single health scale used by the dashboard and the monitoring agent.
 * Applied to the blended score (mean of academic average % and attendance %
 * over the last ATTENDANCE_WINDOW_DAYS; if only one signal exists it is used alone):
 *   GREEN  >= 70
 *   YELLOW 50 - 69
 *   RED    <  50
 * With no academic AND no attendance data the health is UNKNOWN (never assumed).
 */
export const HEALTH_THRESHOLDS = { green: 70, yellow: 50 } as const;
export const ATTENDANCE_WINDOW_DAYS = 30;

export type HealthStatus = 'GREEN' | 'YELLOW' | 'RED' | 'UNKNOWN';

export interface SubjectAnalysis {
  subject: string;
  totalMarks: number;
  obtainedMarks: number;
  percentage: number;
  testCount: number;
  status: 'WEAK' | 'AVERAGE' | 'STRONG';
}

export interface StudentDiagnosis {
  studentId: string;
  studentName: string;
  health: HealthStatus;
  /** Blended score the health band was derived from; null when there is no data. */
  healthScore: number | null;
  /** null when the student has no scored assessments. */
  averagePercentage: number | null;
  /** Attendance % over the last 30 days; null when no attendance was marked. */
  averageAttendance: number | null;
  weakSubjects: string[];
  recommendations: string[];
  subjectBreakdown: SubjectAnalysis[];
}

export interface AttendanceStats {
  attended: number;
  counted: number;
  /** null when nothing countable was marked. */
  percentage: number | null;
}

type RecordLike = { markObtained: unknown; totalMarks: unknown };

/** Score of one assessment as a percentage, or null if it has no usable total. */
export function recordPercentage(r: RecordLike): number | null {
  const total = Number(r.totalMarks ?? 0);
  if (!r.totalMarks || !(total > 0)) return null;
  return (Number(r.markObtained ?? 0) / total) * 100;
}

/** Mean of per-assessment percentages; null if there are no scorable assessments. */
export function academicAverage(records: RecordLike[]): number | null {
  const pcts = records.map(recordPercentage).filter((p): p is number => p !== null);
  if (pcts.length === 0) return null;
  return pcts.reduce((a, b) => a + b, 0) / pcts.length;
}

export function healthFromScore(score: number | null): HealthStatus {
  if (score === null) return 'UNKNOWN';
  if (score >= HEALTH_THRESHOLDS.green) return 'GREEN';
  if (score >= HEALTH_THRESHOLDS.yellow) return 'YELLOW';
  return 'RED';
}

export function blendScore(academicPct: number | null, attendancePct: number | null): number | null {
  const parts = [academicPct, attendancePct].filter((p): p is number => p !== null);
  if (parts.length === 0) return null;
  return parts.reduce((a, b) => a + b, 0) / parts.length;
}

/** Calendar date (YYYY-MM-DD) in Asia/Kolkata for an instant. */
export function istDateString(d: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** First attendance date (UTC midnight of an IST calendar date) in a window ending today. */
export function attendanceWindowStart(days = ATTENDANCE_WINDOW_DAYS, now: Date = new Date()): Date {
  const today = new Date(`${istDateString(now)}T00:00:00.000Z`);
  return new Date(today.getTime() - (days - 1) * 86400000);
}

/**
 * Attendance % per key (student or batch) from the Attendance table.
 * present + late count as attended; excused days are left out of the denominator.
 * Keys with no countable rows are absent from the result (no assumed values).
 */
export async function attendanceStats(
  by: 'studentId' | 'batchId',
  ids: string[],
  days = ATTENDANCE_WINDOW_DAYS,
): Promise<Map<string, AttendanceStats>> {
  const out = new Map<string, AttendanceStats>();
  if (ids.length === 0) return out;
  const rows = await prisma.attendance.groupBy({
    by: [by, 'status'],
    where: { [by]: { in: ids }, date: { gte: attendanceWindowStart(days) } },
    _count: { _all: true },
  });
  for (const row of rows) {
    const key = row[by] as string;
    const cur = out.get(key) ?? { attended: 0, counted: 0, percentage: null };
    if (row.status === 'present' || row.status === 'late') cur.attended += row._count._all;
    if (row.status !== 'excused') cur.counted += row._count._all;
    out.set(key, cur);
  }
  for (const s of out.values()) {
    s.percentage = s.counted > 0 ? Math.round((s.attended / s.counted) * 100) : null;
  }
  for (const [k, s] of out) if (s.percentage === null) out.delete(k);
  return out;
}

export class AcademicMonitoringService {
  /**
   * Deep analysis of a single student's academic records and recent attendance
   */
  async analyzeStudent(studentId: string): Promise<StudentDiagnosis | null> {
    const student = await prisma.student.findUnique({
      where: { id: studentId },
      include: { academicRecords: { orderBy: { testDate: 'desc' } } },
    });

    if (!student) return null;

    const records = student.academicRecords;
    const attendance = (await attendanceStats('studentId', [student.id])).get(student.id);
    const averageAttendance = attendance?.percentage ?? null;

    // 1. Group records by subject
    const subjectMap: Record<string, { total: number; obtained: number; count: number }> = {};
    for (const r of records) {
      if (r.subject) {
        if (!subjectMap[r.subject]) {
          subjectMap[r.subject] = { total: 0, obtained: 0, count: 0 };
        }
        subjectMap[r.subject].total += Number(r.totalMarks ?? 0);
        subjectMap[r.subject].obtained += Number(r.markObtained ?? 0);
        subjectMap[r.subject].count++;
      }
    }

    const subjectBreakdown: SubjectAnalysis[] = Object.entries(subjectMap).map(([subject, data]) => {
      const pct = data.total > 0 ? Math.round((data.obtained / data.total) * 100) : 0;
      let status: 'WEAK' | 'AVERAGE' | 'STRONG' = 'AVERAGE';
      if (pct < 50) status = 'WEAK';
      else if (pct >= 75) status = 'STRONG';

      return {
        subject,
        totalMarks: data.total,
        obtainedMarks: data.obtained,
        percentage: pct,
        testCount: data.count,
        status,
      };
    });

    // 2. Overall averages + health on the shared scale
    const avg = academicAverage(records);
    const averagePercentage = avg === null ? null : Math.round(avg);
    const score = blendScore(avg, averageAttendance);
    const health = healthFromScore(score);

    // 3. Identify weak subjects
    const weakSubjects = subjectBreakdown.filter((s) => s.status === 'WEAK').map((s) => s.subject);

    // 4. Generate recommendations
    const recommendations: string[] = [];
    if (averagePercentage === null) {
      recommendations.push('No assessments recorded yet. Schedule baseline diagnostic test.');
    }
    if (averageAttendance === null) {
      recommendations.push('No attendance marked in the last 30 days.');
    }
    if (weakSubjects.length > 0) {
      recommendations.push(`Assign remedial practice modules in: ${weakSubjects.join(', ')}.`);
      recommendations.push(`Alert subject teacher to review fundamental doubts.`);
    }
    if (averageAttendance !== null && averageAttendance < 80) {
      recommendations.push(`Attendance is ${averageAttendance}% over the last 30 days. Notify parent for check-in.`);
    }
    if (health === 'GREEN') {
      recommendations.push('Excellent progression. Recommend advanced problem-solving challenges.');
    }

    return {
      studentId: student.id,
      studentName: student.fullName,
      health,
      healthScore: score === null ? null : Math.round(score),
      averagePercentage,
      averageAttendance,
      weakSubjects,
      recommendations,
      subjectBreakdown,
    };
  }

  /**
   * Periodic routine: scan all students and update health indicators
   */
  async scanAllStudents(): Promise<{
    totalScanned: number;
    greenCount: number;
    yellowCount: number;
    redCount: number;
    unknownCount: number;
    diagnoses: StudentDiagnosis[];
  }> {
    logger.info('AcademicMonitoringAI beginning full student health evaluation scan...');

    const students = await prisma.student.findMany({
      where: { status: 'active' },
      select: { id: true },
    });

    const diagnoses: StudentDiagnosis[] = [];
    let greenCount = 0;
    let yellowCount = 0;
    let redCount = 0;
    let unknownCount = 0;

    for (const s of students) {
      const diag = await this.analyzeStudent(s.id);
      if (!diag) continue;

      diagnoses.push(diag);
      if (diag.health === 'GREEN') greenCount++;
      else if (diag.health === 'YELLOW') yellowCount++;
      else if (diag.health === 'RED') redCount++;
      else unknownCount++;

      // Log alert if student is RED (Academic Monitoring AI alert)
      if (diag.health === 'RED') {
        await aiActivityLogService.log({
          agentId: 'AcademicMonitoringAI',
          targetId: s.id,
          actionType: 'student_health_flagged_red',
          payload: {
            studentName: diag.studentName,
            averagePercentage: diag.averagePercentage,
            weakSubjects: diag.weakSubjects,
            attendance: diag.averageAttendance,
            recommendations: diag.recommendations,
          },
          status: 'success',
        });
      }
    }

    logger.info(`AcademicMonitoringAI scan complete: ${students.length} students. Green: ${greenCount}, Yellow: ${yellowCount}, Red: ${redCount}, Unknown: ${unknownCount}`);

    return {
      totalScanned: students.length,
      greenCount,
      yellowCount,
      redCount,
      unknownCount,
      diagnoses,
    };
  }
}

export const academicMonitoringService = new AcademicMonitoringService();
