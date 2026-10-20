import 'dotenv/config';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';

// Only the external WhatsApp delivery is mocked; everything else hits the real DB / Redis.
const enqueue = vi.hoisted(() => vi.fn());
vi.mock('../utils/queues', () => ({ enqueueWhatsApp: enqueue }));

import app from '../app';
import { prisma } from '../utils/database';
import { redis, connectRedis } from '../utils/redis';
import { signToken } from '../utils/jwt';
import { generateWeeklyReport, computeMetrics, currentWeekStart } from './weekly-report.service';
import { dateOnly, istParts } from './scheduler.service';

const sfx = randomUUID().slice(0, 8);
const WEEK = '2026-03-02'; // Monday
const PREV = '2026-02-23';
const d = (s: string) => dateOnly(s);

const ids = {
  courseId: '', batchA: '', batchB: '', teacherA: '', teacherB: '', parentA: '', parentB: '',
  stuA: '', stuB: '', stuC: '',
};
const phone = () => '9' + String(Math.floor(Math.random() * 1e11)).padStart(11, '0');

const adminToken = signToken({ userId: randomUUID(), email: `admin-${sfx}@x.test`, role: 'admin' });
let teacherAToken = '';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  if (redis.status === 'wait') await connectRedis();
  const course = await prisma.course.create({ data: { courseName: `RPT-${sfx}` } });
  ids.courseId = course.id;
  const mkTeacher = (n: string) => prisma.user.create({ data: { fullName: `T${n} ${sfx}`, email: `t${n}-${sfx}@x.test`, passwordHash: 'x', role: 'teacher' } });
  const [tA, tB] = [await mkTeacher('A'), await mkTeacher('B')];
  ids.teacherA = tA.id; ids.teacherB = tB.id;
  teacherAToken = signToken({ userId: tA.id, email: tA.email, role: 'teacher' });
  ids.batchA = (await prisma.batch.create({ data: { courseId: course.id, batchName: `BA-${sfx}`, teacherId: tA.id } })).id;
  ids.batchB = (await prisma.batch.create({ data: { courseId: course.id, batchName: `BB-${sfx}`, teacherId: tB.id } })).id;
  ids.parentA = (await prisma.parent.create({ data: { fullName: `PA ${sfx}`, whatsappNumber: phone() } })).id;
  ids.parentB = (await prisma.parent.create({ data: { fullName: `PB ${sfx}`, whatsappNumber: phone(), optedOut: true } })).id;
  ids.stuA = (await prisma.student.create({ data: { fullName: `Asha ${sfx}`, parentId: ids.parentA } })).id;
  ids.stuB = (await prisma.student.create({ data: { fullName: `Bala ${sfx}`, parentId: ids.parentB } })).id;
  ids.stuC = (await prisma.student.create({ data: { fullName: `Chitra ${sfx}`, parentId: ids.parentA } })).id;
  await prisma.enrollment.createMany({ data: [
    { studentId: ids.stuA, batchId: ids.batchA },
    { studentId: ids.stuC, batchId: ids.batchA },
    { studentId: ids.stuB, batchId: ids.batchB },
  ] });
  const att = (studentId: string, batchId: string, date: string, status: 'present' | 'absent' | 'late') => ({ studentId, batchId, date: d(date), status });
  await prisma.attendance.createMany({ data: [
    att(ids.stuA, ids.batchA, '2026-03-02', 'present'),
    att(ids.stuA, ids.batchA, '2026-03-03', 'late'),
    att(ids.stuA, ids.batchA, '2026-03-04', 'absent'),
    att(ids.stuA, ids.batchA, '2026-02-23', 'present'),
    att(ids.stuA, ids.batchA, '2026-02-24', 'present'),
  ] });
  const rec = (studentId: string, subject: string, o: number, date: string) => ({ studentId, subject, markObtained: o, totalMarks: 100, testDate: d(date) });
  await prisma.academicRecord.createMany({ data: [
    rec(ids.stuA, 'Maths', 40, '2026-03-03'),
    rec(ids.stuA, 'English', 80, '2026-03-04'),
    rec(ids.stuA, 'Maths', 60, '2026-02-24'),
  ] });
});

afterAll(async () => {
  const studentIds = [ids.stuA, ids.stuB, ids.stuC];
  await prisma.aiActivityLog.deleteMany({ where: { targetId: { in: studentIds } } });
  await prisma.message.deleteMany({ where: { studentId: { in: studentIds } } });
  await prisma.weeklyReport.deleteMany({ where: { studentId: { in: studentIds } } });
  await prisma.attendance.deleteMany({ where: { studentId: { in: studentIds } } });
  await prisma.academicRecord.deleteMany({ where: { studentId: { in: studentIds } } });
  await prisma.enrollment.deleteMany({ where: { studentId: { in: studentIds } } });
  await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
  await prisma.parent.deleteMany({ where: { id: { in: [ids.parentA, ids.parentB] } } });
  await prisma.batch.deleteMany({ where: { id: { in: [ids.batchA, ids.batchB] } } });
  await prisma.course.deleteMany({ where: { id: ids.courseId } });
  await prisma.user.deleteMany({ where: { id: { in: [ids.teacherA, ids.teacherB] } } });
  await prisma.$disconnect();
});

beforeEach(() => {
  enqueue.mockReset();
  enqueue.mockResolvedValue(undefined);
});

describe('IST helpers', () => {
  it('maps UTC instants to the IST calendar date/time', () => {
    const p = istParts(new Date('2026-03-06T20:00:00Z')); // 01:30 Sat IST
    expect(p.dateStr).toBe('2026-03-07');
    expect(p.timeStr).toBe('01:30');
    expect(p.dayOfWeek).toBe(6);
    expect(currentWeekStart('2026-03-07')).toBe('2026-03-02');
    expect(currentWeekStart('2026-03-08')).toBe('2026-03-02'); // Sunday -> previous Monday
  });
});

describe('weekly report generation', () => {
  it('computes real metrics from attendance and marks', async () => {
    const m = await computeMetrics(ids.stuA, WEEK);
    expect(m.attendance).toMatchObject({ markedDays: 3, attendedDays: 2, absentDays: 1, percentage: 66.7, previousPercentage: 100 });
    expect(m.marks).toMatchObject({ assessments: 2, percentage: 60, previousPercentage: 60, trend: 'steady' });
    expect(m.weakSubjects).toEqual(['Maths']);
    void PREV;
  });

  it('upserts a draft with a deterministic summary and does not overwrite non-drafts', async () => {
    const r = await generateWeeklyReport(ids.stuA, WEEK);
    expect(r.action).toBe('created');
    expect(r.report.status).toBe('draft');
    expect(r.report.summary).toContain('attended 2 of 3');
    expect(r.report.summary).toContain('Maths');
    expect((r.report.metrics as any).summarySource).toBe('template');

    const again = await generateWeeklyReport(ids.stuA, WEEK);
    expect(again.action).toBe('kept_existing');
    const forced = await generateWeeklyReport(ids.stuA, WEEK, { force: true });
    expect(forced.action).toBe('regenerated');
    expect(forced.report.id).toBe(r.report.id);

    await prisma.weeklyReport.update({ where: { id: r.report.id }, data: { status: 'approved' } });
    const protectedRun = await generateWeeklyReport(ids.stuA, WEEK, { force: true });
    expect(protectedRun.action).toBe('kept_existing');
    await prisma.weeklyReport.delete({ where: { id: r.report.id } });
  });

  it('rejects a non-Monday weekStart and unknown students', async () => {
    await expect(generateWeeklyReport(ids.stuA, '2026-03-03')).rejects.toThrow(/Monday/);
    await expect(generateWeeklyReport(randomUUID(), WEEK)).rejects.toThrow(/not found/i);
  });

  describe('LLM rewrite', () => {
    const origFetch = globalThis.fetch;
    const env = { ...process.env };
    afterAll(() => { globalThis.fetch = origFetch; process.env = env; });

    it('uses the LLM text when it succeeds and keeps the template when it fails', async () => {
      process.env.USE_REAL_LLM = 'true';
      process.env.LLM_PROVIDER = 'openai';
      process.env.OPENAI_API_KEY = 'test-key';

      globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: 'Asha had a lovely week with 66.7% attendance and needs a little help in Maths.' } }] }) }) as any;
      const ok = await generateWeeklyReport(ids.stuC, WEEK, { force: true });
      expect(ok.report.summary).toContain('lovely week');
      expect((ok.report.metrics as any).summarySource).toBe('llm');

      globalThis.fetch = vi.fn().mockRejectedValue(new Error('boom')) as any;
      const bad = await generateWeeklyReport(ids.stuC, WEEK, { force: true });
      expect(bad.report.summary).toContain('Weekly update for');
      expect((bad.report.metrics as any).summarySource).toBe('template');
      await prisma.weeklyReport.deleteMany({ where: { studentId: ids.stuC } });
    });
  });
});

describe('report routes', () => {
  it('requires auth and the reports:review permission', async () => {
    expect((await request(app).get('/api/v1/reports')).status).toBe(401);
    expect((await request(app).get('/api/v1/reports').set(auth(teacherAToken))).status).toBe(403);
  });

  it('validates input', async () => {
    const bad = await request(app).post('/api/v1/reports/generate').set(auth(adminToken)).send({ weekStart: '2026-03-03', batchId: ids.batchA });
    expect(bad.status).toBe(400);
    const bad2 = await request(app).post('/api/v1/reports/generate').set(auth(adminToken)).send({ batchId: 'nope' });
    expect(bad2.status).toBe(400);
    expect((await request(app).get('/api/v1/reports/not-a-uuid').set(auth(adminToken))).status).toBe(400);
    expect((await request(app).get(`/api/v1/reports/${randomUUID()}`).set(auth(adminToken))).status).toBe(404);
  });

  it('runs generate -> edit -> approve -> send, never sending drafts or opted-out parents', async () => {
    const gen = await request(app).post('/api/v1/reports/generate').set(auth(adminToken)).send({ weekStart: WEEK, batchId: ids.batchA });
    expect(gen.status).toBe(201);
    expect(gen.body).toMatchObject({ created: 2, failed: [] });
    const genB = await request(app).post('/api/v1/reports/generate').set(auth(adminToken)).send({ weekStart: WEEK, batchId: ids.batchB });
    expect(genB.body.created).toBe(1);

    const list = await request(app).get(`/api/v1/reports?weekStart=${WEEK}&batchId=${ids.batchA}&status=draft`).set(auth(adminToken));
    expect(list.status).toBe(200);
    const mine = list.body.filter((r: any) => [ids.stuA, ids.stuC].includes(r.studentId));
    expect(mine).toHaveLength(2);
    const repA = mine.find((r: any) => r.studentId === ids.stuA);
    const repC = mine.find((r: any) => r.studentId === ids.stuC);
    const repB = (await prisma.weeklyReport.findFirst({ where: { studentId: ids.stuB } }))!;

    // Draft cannot be sent
    const sendDraft = await request(app).post(`/api/v1/reports/${repA.id}/send`).set(auth(adminToken));
    expect(sendDraft.status).toBe(409);
    expect(enqueue).not.toHaveBeenCalled();

    // Edit while draft
    const edit = await request(app).patch(`/api/v1/reports/${repA.id}`).set(auth(adminToken)).send({ summary: 'Edited by reviewer' });
    expect(edit.status).toBe(200);
    expect(edit.body.summary).toBe('Edited by reviewer');

    // Bulk approve
    const bulk = await request(app).post('/api/v1/reports/bulk-approve').set(auth(adminToken)).send({ ids: [repA.id, repB.id, randomUUID()] });
    expect(bulk.status).toBe(200);
    expect(bulk.body.approved.sort()).toEqual([repA.id, repB.id].sort());
    expect(bulk.body.skipped).toHaveLength(1);

    // Cannot edit or re-approve after approval
    expect((await request(app).patch(`/api/v1/reports/${repA.id}`).set(auth(adminToken)).send({ summary: 'x' })).status).toBe(409);
    expect((await request(app).post(`/api/v1/reports/${repA.id}/approve`).set(auth(adminToken))).status).toBe(409);

    // Opted-out parent is skipped and the report stays approved
    const sendB = await request(app).post(`/api/v1/reports/${repB.id}/send`).set(auth(adminToken));
    expect(sendB.status).toBe(422);
    expect(enqueue).not.toHaveBeenCalled();
    expect((await prisma.weeklyReport.findUnique({ where: { id: repB.id } }))!.status).toBe('approved');

    // Send one approved report
    const sendA = await request(app).post(`/api/v1/reports/${repA.id}/send`).set(auth(adminToken));
    expect(sendA.status).toBe(200);
    expect(sendA.body.report.status).toBe('sent');
    expect(sendA.body.report.sentAt).toBeTruthy();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][0].text).toContain('Edited by reviewer');
    const msg = await prisma.message.findFirst({ where: { studentId: ids.stuA, agentId: 'WeeklyReportAI' } });
    expect(msg).toMatchObject({ direction: 'outbound', status: 'queued', parentId: ids.parentA });
    expect((await request(app).post(`/api/v1/reports/${repA.id}/send`).set(auth(adminToken))).status).toBe(409);

    // send-approved only touches approved reports; repC is still a draft
    await prisma.weeklyReport.update({ where: { id: repB.id }, data: { status: 'draft' } });
    enqueue.mockClear();
    const all = await request(app).post('/api/v1/reports/send-approved').set(auth(adminToken));
    expect(all.status).toBe(200);
    expect((await prisma.weeklyReport.findUnique({ where: { id: repC.id } }))!.status).toBe('draft');
    expect(enqueue.mock.calls.some((c) => c[0].targetId === ids.stuC)).toBe(false);
  });

  it('marks a report failed when delivery cannot be queued', async () => {
    const rep = await prisma.weeklyReport.findFirstOrThrow({ where: { studentId: ids.stuC } });
    await prisma.weeklyReport.update({ where: { id: rep.id }, data: { status: 'approved' } });
    enqueue.mockRejectedValue(new Error('queue down'));
    const res = await request(app).post(`/api/v1/reports/${rep.id}/send`).set(auth(adminToken));
    expect(res.status).toBe(502);
    const after = await prisma.weeklyReport.findUnique({ where: { id: rep.id } });
    expect(after!.status).toBe('failed');
    const msg = await prisma.message.findFirst({ where: { studentId: ids.stuC, status: 'failed:enqueue' } });
    expect(msg).toBeTruthy();
  });
});
