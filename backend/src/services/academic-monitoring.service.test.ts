import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { prisma } from '../utils/database';
import { academicMonitoringService, healthFromScore, blendScore, istDateString } from './academic-monitoring.service';
import { aiActivityLogService } from './ai-activity-log.service';

const sfx = randomUUID().slice(0, 8);
let parentId: string, courseId: string, batchId: string, emptyId: string, mixedId: string;

beforeAll(async () => {
  parentId = (await prisma.parent.create({ data: { fullName: `Mon ${sfx}`, whatsappNumber: `5${Date.now()}`.slice(0, 15) } })).id;
  courseId = (await prisma.course.create({ data: { courseName: `Mon Course ${sfx}` } })).id;
  batchId = (await prisma.batch.create({ data: { courseId } })).id;
  emptyId = (await prisma.student.create({ data: { parentId, fullName: `Empty ${sfx}` } })).id;
  mixedId = (await prisma.student.create({ data: { parentId, fullName: `Mixed ${sfx}` } })).id;
  await prisma.academicRecord.create({ data: { studentId: mixedId, subject: 'Maths', markObtained: 40, totalMarks: 100, testDate: new Date('2026-09-01') } });
  const today = new Date(`${istDateString()}T00:00:00Z`);
  await prisma.attendance.createMany({
    data: [0, 1, 2, 3].map((n) => ({ studentId: mixedId, batchId, date: new Date(today.getTime() - n * 86400000), status: n === 0 ? ('absent' as const) : ('present' as const) })),
  });
});
afterAll(async () => {
  await prisma.attendance.deleteMany({ where: { studentId: mixedId } });
  await prisma.academicRecord.deleteMany({ where: { studentId: mixedId } });
  await prisma.student.deleteMany({ where: { id: { in: [emptyId, mixedId] } } });
  await prisma.batch.delete({ where: { id: batchId } });
  await prisma.course.delete({ where: { id: courseId } });
  await prisma.parent.delete({ where: { id: parentId } });
  await prisma.aiActivityLog.deleteMany({ where: { targetId: { in: [`long-${sfx}`.padEnd(64, 'x')] } } });
});

describe('academic monitoring', () => {
  it('maps scores to the single health scale', () => {
    expect(healthFromScore(70)).toBe('GREEN');
    expect(healthFromScore(69.9)).toBe('YELLOW');
    expect(healthFromScore(50)).toBe('YELLOW');
    expect(healthFromScore(49.9)).toBe('RED');
    expect(healthFromScore(null)).toBe('UNKNOWN');
    expect(blendScore(80, 60)).toBe(70);
    expect(blendScore(null, 60)).toBe(60);
    expect(blendScore(null, null)).toBeNull();
  });

  it('does not assume attendance or health when there is no data', async () => {
    const d = await academicMonitoringService.analyzeStudent(emptyId);
    expect(d).toMatchObject({ health: 'UNKNOWN', averageAttendance: null, averagePercentage: null, healthScore: null });
  });

  it('computes attendance from the Attendance table and blends it with marks', async () => {
    const d = await academicMonitoringService.analyzeStudent(mixedId);
    expect(d!.averageAttendance).toBe(75); // 3 of 4
    expect(d!.averagePercentage).toBe(40);
    expect(d!.healthScore).toBe(58); // (40 + 75) / 2 = 57.5
    expect(d!.health).toBe('YELLOW');
  });
});

describe('ai activity log', () => {
  it('accepts free-form non-UUID target ids', async () => {
    const targetId = `call:+91-98765:${sfx}`;
    expect(await aiActivityLogService.log({ agentId: 'TestAgent', targetId, actionType: 'test', status: 'success' })).toBe(true);
    expect(await prisma.aiActivityLog.count({ where: { targetId } })).toBe(1);
    await prisma.aiActivityLog.deleteMany({ where: { targetId } });
  });

  it('truncates over-long target ids instead of failing silently', async () => {
    const targetId = `long-${sfx}`.padEnd(64, 'x') + 'overflow';
    expect(await aiActivityLogService.log({ agentId: 'TestAgent', targetId, actionType: 'test', status: 'success' })).toBe(true);
    expect(await prisma.aiActivityLog.count({ where: { targetId: targetId.slice(0, 64) } })).toBe(1);
  });
});
