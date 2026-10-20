import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { prisma } from '../utils/database';
import { signToken } from '../utils/jwt';
import { istDateString, computeAttendancePercentage, parseYmd } from '../services/attendance.service';

const enqueue = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../utils/queues', () => ({ enqueueWhatsApp: enqueue }));

const sfx = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const ids: Record<string, string> = {};
let app: any;
const tok = (userId: string, role: any) => signToken({ userId, email: `${userId}@t.test`, role });
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  app = (await import('../app')).default;
  const mk = (n: string, role: any, phone?: string) =>
    prisma.user.create({ data: { fullName: `T ${n} ${sfx}`, email: `${n}-${sfx}@t.test`, passwordHash: 'x', role, phone } });
  const t1 = await mk('t1', 'teacher', `+9199${sfx.replace(/\D/g, '').padEnd(8, '1').slice(0, 8)}`);
  const t2 = await mk('t2', 'teacher');
  const mgr = await mk('mgr', 'manager');
  const course = await prisma.course.create({ data: { courseName: `C ${sfx}` } });
  const batch = await prisma.batch.create({ data: { courseId: course.id, batchName: `B ${sfx}`, teacherId: t1.id } });
  const parentA = await prisma.parent.create({ data: { fullName: `PA ${sfx}`, whatsappNumber: `9${Date.now()}`.slice(0, 15) } });
  const parentB = await prisma.parent.create({ data: { fullName: `PB ${sfx}`, whatsappNumber: `8${Date.now()}`.slice(0, 15), optedOut: true } });
  const s1 = await prisma.student.create({ data: { parentId: parentA.id, fullName: `S1 ${sfx}` } });
  const s2 = await prisma.student.create({ data: { parentId: parentA.id, fullName: `S2 ${sfx}` } });
  const s3 = await prisma.student.create({ data: { parentId: parentB.id, fullName: `S3 ${sfx}` } });
  const outsider = await prisma.student.create({ data: { parentId: parentA.id, fullName: `S4 ${sfx}` } });
  for (const s of [s1, s2, s3]) await prisma.enrollment.create({ data: { studentId: s.id, batchId: batch.id } });
  Object.assign(ids, { t1: t1.id, t2: t2.id, mgr: mgr.id, course: course.id, batch: batch.id, pA: parentA.id, pB: parentB.id, s1: s1.id, s2: s2.id, s3: s3.id, out: outsider.id });
});

afterAll(async () => {
  await prisma.message.deleteMany({ where: { parentId: { in: [ids.pA, ids.pB] } } });
  await prisma.classSession.deleteMany({ where: { batchId: ids.batch } });
  await prisma.attendance.deleteMany({ where: { batchId: ids.batch } });
  await prisma.enrollment.deleteMany({ where: { batchId: ids.batch } });
  await prisma.student.deleteMany({ where: { id: { in: [ids.s1, ids.s2, ids.s3, ids.out] } } });
  await prisma.parent.deleteMany({ where: { id: { in: [ids.pA, ids.pB] } } });
  await prisma.batch.delete({ where: { id: ids.batch } });
  await prisma.course.delete({ where: { id: ids.course } });
  await prisma.user.deleteMany({ where: { id: { in: [ids.t1, ids.t2, ids.mgr] } } });
  await prisma.$disconnect();
});

describe('attendance routes', () => {
  const day = '2026-01-12';
  it('marks, upserts and reads back the roster', async () => {
    const t = tok(ids.t1, 'teacher');
    const body = (st: string) => ({ date: day, entries: [{ studentId: ids.s1, status: st }, { studentId: ids.s2, status: 'absent', note: 'sick' }] });
    expect((await request(app).post(`/api/v1/attendance/batches/${ids.batch}`).set(auth(t)).send(body('present'))).status).toBe(200);
    expect((await request(app).post(`/api/v1/attendance/batches/${ids.batch}`).set(auth(t)).send(body('late'))).status).toBe(200);
    const res = await request(app).get(`/api/v1/attendance/batches/${ids.batch}?date=${day}`).set(auth(t));
    const by = Object.fromEntries(res.body.roster.map((r: any) => [r.studentId, r.status]));
    expect(by).toEqual({ [ids.s1]: 'late', [ids.s2]: 'absent', [ids.s3]: null });
    expect(await prisma.attendance.count({ where: { batchId: ids.batch } })).toBe(2);
  });

  it('rejects future dates, non-enrolled students and bad input', async () => {
    const t = tok(ids.mgr, 'manager');
    const url = `/api/v1/attendance/batches/${ids.batch}`;
    const future = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
    expect((await request(app).post(url).set(auth(t)).send({ date: future, entries: [{ studentId: ids.s1, status: 'present' }] })).status).toBe(400);
    expect((await request(app).post(url).set(auth(t)).send({ date: day, entries: [{ studentId: ids.out, status: 'present' }] })).status).toBe(400);
    expect((await request(app).post(url).set(auth(t)).send({ date: '2026-02-30', entries: [] })).status).toBe(400);
  });

  it('enforces batch scoping and auth', async () => {
    const other = tok(ids.t2, 'teacher');
    expect((await request(app).get(`/api/v1/attendance/batches/${ids.batch}?date=${day}`).set(auth(other))).status).toBe(403);
    expect((await request(app).get(`/api/v1/attendance/students/${ids.s1}?from=${day}&to=${day}`).set(auth(other))).status).toBe(403);
    expect((await request(app).get(`/api/v1/attendance/batches/${ids.batch}?date=${day}`)).status).toBe(401);
  });

  it('computes percentage, history and summary', async () => {
    const t = tok(ids.t1, 'teacher');
    await request(app).post(`/api/v1/attendance/batches/${ids.batch}`).set(auth(t))
      .send({ date: '2026-01-13', entries: [{ studentId: ids.s1, status: 'absent' }] });
    const r = await computeAttendancePercentage(ids.s1, parseYmd('2026-01-12')!, parseYmd('2026-01-13')!);
    expect(r).toEqual({ markedDays: 2, presentDays: 1, percentage: 50 });
    expect(await computeAttendancePercentage(ids.s3, parseYmd('2026-01-12')!, parseYmd('2026-01-13')!))
      .toEqual({ markedDays: 0, presentDays: 0, percentage: null });
    const hist = await request(app).get(`/api/v1/attendance/students/${ids.s1}?from=2026-01-01&to=2026-01-31`).set(auth(t));
    expect(hist.body.percentage).toBe(50);
    expect(hist.body.history).toHaveLength(2);
    const sum = await request(app).get(`/api/v1/attendance/batches/${ids.batch}/summary?from=2026-01-01&to=2026-01-31`).set(auth(t));
    expect(sum.status).toBe(200);
    const s2 = sum.body.students.find((s: any) => s.studentId === ids.s2);
    expect(s2.unmarkedDays).toEqual(['2026-01-13']);
  });
});

describe('class sessions + announcements', () => {
  it('validates, scopes and announces exactly once', async () => {
    const t = tok(ids.t1, 'teacher');
    const startsAt = new Date(Date.now() + 3600e3).toISOString();
    const bad = await request(app).post('/api/v1/sessions').set(auth(t)).send({ batchId: ids.batch, startsAt, meetingUrl: 'http://meet.example.com/x' });
    expect(bad.status).toBe(400);
    expect((await request(app).post('/api/v1/sessions').set(auth(tok(ids.t2, 'teacher'))).send({ batchId: ids.batch, startsAt, meetingUrl: 'https://meet.example.com/x' })).status).toBe(403);

    const created = await request(app).post('/api/v1/sessions').set(auth(t))
      .send({ batchId: ids.batch, topic: 'Algebra', startsAt, meetingUrl: 'https://meet.example.com/x' });
    expect(created.status).toBe(201);
    const id = created.body.id;

    // non-creator teacher cannot modify; manager can
    expect((await request(app).patch(`/api/v1/sessions/${id}`).set(auth(tok(ids.t2, 'teacher'))).send({ topic: 'x' })).status).toBe(403);
    expect((await request(app).patch(`/api/v1/sessions/${id}`).set(auth(tok(ids.mgr, 'manager'))).send({ topic: 'Algebra II' })).body.topic).toBe('Algebra II');

    enqueue.mockClear();
    const a = await request(app).post(`/api/v1/sessions/${id}/announce`).set(auth(t));
    expect(a.status).toBe(200);
    // parentA has 2 kids -> 1 message; parentB opted out; teacher has a phone
    expect(a.body).toMatchObject({ parentsMessaged: 1, parentsSkippedOptedOut: 1, teacherMessaged: true });
    expect(enqueue).toHaveBeenCalledTimes(2);
    const parentCall = enqueue.mock.calls.find((c) => c[0].text.includes(`S1 ${sfx}`))![0];
    expect(parentCall.text).toContain(`S2 ${sfx}`);
    expect(parentCall.text).toContain('https://meet.example.com/x');
    expect(await prisma.message.count({ where: { parentId: ids.pA, direction: 'outbound' } })).toBe(1);

    expect((await request(app).post(`/api/v1/sessions/${id}/announce`).set(auth(t))).status).toBe(409);
    expect(enqueue).toHaveBeenCalledTimes(2);

    const today = await request(app).get('/api/v1/sessions?batchId=' + ids.batch).set(auth(t));
    expect(today.body).toHaveLength(1);
    expect((await request(app).delete(`/api/v1/sessions/${id}`).set(auth(t))).status).toBe(204);
  });

  it('releases the claim when nothing could be queued', async () => {
    const { announceSession } = await import('../services/class-link.service');
    const s = await prisma.classSession.create({ data: { batchId: ids.batch, startsAt: new Date(Date.now() + 3600e3), meetingUrl: 'https://m.example.com/y' } });
    enqueue.mockRejectedValue(new Error('redis down'));
    await expect(announceSession(s.id)).rejects.toThrow();
    enqueue.mockResolvedValue(undefined);
    expect((await prisma.classSession.findUnique({ where: { id: s.id } }))!.announcedAt).toBeNull();
  });
});

it('istDateString converts across midnight', () => {
  expect(istDateString(new Date('2026-01-12T19:00:00Z'))).toBe('2026-01-13');
});
