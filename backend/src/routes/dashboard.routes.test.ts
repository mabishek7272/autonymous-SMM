import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { UserRole } from '@prisma/client';
import app from '../app';
import { prisma } from '../utils/database';
import { signToken } from '../utils/jwt';
import { HEALTH_THRESHOLDS } from './dashboard.routes';
import { istDateString } from '../services/academic-monitoring.service';

const sfx = randomUUID().slice(0, 8);
const mgr = () => ({ Authorization: `Bearer ${signToken({ userId: randomUUID(), email: 'm@x.in', role: UserRole.manager })}` });
const teacher = () => ({ Authorization: `Bearer ${signToken({ userId: randomUUID(), email: 't@x.in', role: UserRole.teacher })}` });

let parentId: string, courseId: string, batchId: string, teacherId: string;
let healthyId: string, unknownId: string, redId: string;

beforeAll(async () => {
  parentId = (await prisma.parent.create({ data: { fullName: `Dash Parent ${sfx}`, whatsappNumber: `8${Date.now()}`.slice(0, 15), email: `p${sfx}@x.in` } })).id;
  courseId = (await prisma.course.create({ data: { courseName: `Dash Course ${sfx}` } })).id;
  teacherId = (await prisma.user.create({ data: { fullName: `Dash Teacher ${sfx}`, email: `t${sfx}@x.in`, passwordHash: 'x', role: 'teacher' } })).id;
  batchId = (await prisma.batch.create({ data: { courseId, batchName: `Dash Batch ${sfx}`, teacherId } })).id;
  const mk = async (name: string) => (await prisma.student.create({ data: { parentId, fullName: `${name} ${sfx}` } })).id;
  healthyId = await mk('Healthy');
  unknownId = await mk('Unknown');
  redId = await mk('Red');
  for (const id of [healthyId, unknownId, redId]) await prisma.enrollment.create({ data: { studentId: id, batchId } });

  await prisma.academicRecord.createMany({
    data: [
      { studentId: healthyId, subject: 'Maths', markObtained: 90, totalMarks: 100, testDate: new Date('2026-09-01') },
      { studentId: healthyId, subject: 'Maths', markObtained: 80, totalMarks: 100, testDate: new Date('2026-09-10') },
      { studentId: healthyId, subject: 'Science', markObtained: 40, totalMarks: 50, testDate: new Date('2026-09-05') },
      { studentId: redId, subject: 'Maths', markObtained: 20, totalMarks: 100, testDate: new Date('2026-09-05') },
    ],
  });
  const today = new Date(`${istDateString()}T00:00:00Z`);
  const day = (n: number) => new Date(today.getTime() - n * 86400000);
  await prisma.attendance.createMany({
    data: [
      { studentId: healthyId, batchId, date: day(0), status: 'present' },
      { studentId: healthyId, batchId, date: day(1), status: 'late' },
      { studentId: healthyId, batchId, date: day(2), status: 'present' },
      { studentId: healthyId, batchId, date: day(3), status: 'excused' },
      { studentId: redId, batchId, date: day(0), status: 'absent' },
      { studentId: redId, batchId, date: day(1), status: 'absent' },
      // outside the 30-day window: must be ignored
      { studentId: unknownId, batchId, date: day(45), status: 'present' },
    ],
  });
});

afterAll(async () => {
  const ids = [healthyId, unknownId, redId];
  await prisma.attendance.deleteMany({ where: { studentId: { in: ids } } });
  await prisma.academicRecord.deleteMany({ where: { studentId: { in: ids } } });
  await prisma.enrollment.deleteMany({ where: { studentId: { in: ids } } });
  await prisma.student.deleteMany({ where: { id: { in: ids } } });
  await prisma.batch.delete({ where: { id: batchId } });
  await prisma.course.delete({ where: { id: courseId } });
  await prisma.user.delete({ where: { id: teacherId } });
  await prisma.parent.delete({ where: { id: parentId } });
});

describe('dashboard', () => {
  it('is not available to teachers', async () => {
    expect((await request(app).get('/api/v1/dashboard/kpis').set(teacher())).status).toBe(403);
  });

  it('exports the health thresholds', () => {
    expect(HEALTH_THRESHOLDS).toEqual({ green: 70, yellow: 50 });
  });

  it('kpis and lead-pipeline return all 7 stages', async () => {
    const kpis = await request(app).get('/api/v1/dashboard/kpis').set(mgr());
    expect(Object.keys(kpis.body.leadsByStage)).toEqual(['enquiry', 'contacted', 'qualified', 'demo_scheduled', 'follow_up', 'converted', 'lost']);
    const pipe = await request(app).get('/api/v1/dashboard/lead-pipeline').set(mgr());
    expect(pipe.body.pipeline.map((p: any) => p.status)).toEqual(['enquiry', 'contacted', 'qualified', 'demo_scheduled', 'follow_up', 'converted', 'lost']);
  });

  it('funnel uses consistent bases', async () => {
    const res = await request(app).get('/api/v1/dashboard/funnel-analytics').set(mgr());
    expect(res.status).toBe(200);
    const { stages, totalLeads, lost } = res.body;
    expect(stages.map((s: any) => s.stage)).toEqual(['enquiry', 'contacted', 'qualified', 'demo_scheduled', 'follow_up', 'converted']);
    expect(stages[0].reached).toBe(totalLeads);
    if (totalLeads > 0) expect(stages[0].conversionFromFirst).toBe(100);
    expect(stages[0].dropOffFromPrevious).toBeNull();
    for (let i = 1; i < stages.length; i++) {
      expect(stages[i].reached).toBeLessThanOrEqual(stages[i - 1].reached);
      if (stages[i - 1].reached > 0) {
        expect(stages[i].dropOffFromPrevious + (stages[i].reached / stages[i - 1].reached) * 100).toBeCloseTo(100, 0);
      }
    }
    expect(stages.reduce((a: number, s: any) => a + s.count, 0) + lost.count).toBe(totalLeads);
  });

  it('student-health computes from real attendance + marks, with no parent PII', async () => {
    const res = await request(app).get('/api/v1/dashboard/student-health').set(mgr());
    expect(res.status).toBe(200);
    const by = (id: string) => res.body.find((s: any) => s.id === id);

    const healthy = by(healthyId);
    // Marks: mean(90, 80, 80) = 83.33; attendance: 3 attended / 3 counted (excused ignored) = 100 -> blended 91.7
    expect(healthy.attendancePercentage).toBe(100);
    expect(healthy.averagePercentage).toBe(83);
    expect(healthy.health).toBe('GREEN');
    expect(healthy.subjectAverages).toEqual([
      { subject: 'Maths', averagePercentage: 85, testsCount: 2 },
      { subject: 'Science', averagePercentage: 80, testsCount: 1 },
    ]);
    expect(healthy.lastAssessment.subject).toBe('Maths');
    expect(healthy.lastAssessment.percentage).toBe(80);
    expect(healthy.parent).toEqual({ id: parentId, fullName: `Dash Parent ${sfx}` });
    expect(JSON.stringify(healthy)).not.toContain('whatsapp');
    expect(JSON.stringify(healthy)).not.toContain('@x.in');

    const red = by(redId);
    expect(red.attendancePercentage).toBe(0);
    expect(red.health).toBe('RED'); // blended (20 + 0)/2 = 10

    const unknown = by(unknownId);
    expect(unknown.attendancePercentage).toBeNull(); // only attendance is outside the window
    expect(unknown.averagePercentage).toBeNull();
    expect(unknown.health).toBe('UNKNOWN');
    expect(unknown.lastAssessment).toBeNull();
  });

  it('overview returns real aggregates', async () => {
    const res = await request(app).get('/api/v1/dashboard/overview?days=7').set(mgr());
    expect(res.status).toBe(200);
    expect(res.body.leads.newLeadsPerDay).toHaveLength(7);
    expect(res.body.leads.newLeadsPerDay[6].date).toBe(istDateString());
    const sum = res.body.leads.newLeadsPerDay.reduce((a: number, d: any) => a + d.count, 0);
    expect(sum).toBe(res.body.leads.total);
    const payments = await prisma.payment.count();
    if (payments === 0) expect(res.body.revenue).toBeNull();
    const row = res.body.batches.find((b: any) => b.batchId === batchId);
    expect(row).toMatchObject({ batch: `Dash Batch ${sfx}`, teacher: { id: teacherId, name: `Dash Teacher ${sfx}` }, students: 3 });
    expect(row.attendance).toBe(Math.round((3 / 5) * 100)); // 3 attended of 5 countable in window
    expect(row.avgScore).toBe(Math.round((90 + 80 + 80 + 20) / 4));
    expect(['GREEN', 'YELLOW', 'RED']).toContain(row.health);
  });

  it('overview validates days', async () => {
    expect((await request(app).get('/api/v1/dashboard/overview?days=0').set(mgr())).status).toBe(400);
    expect((await request(app).get('/api/v1/dashboard/overview?days=abc').set(mgr())).status).toBe(400);
  });
});
