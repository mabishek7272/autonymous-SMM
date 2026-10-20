import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { prisma } from '../utils/database';
import { signToken } from '../utils/jwt';
import { materializeTodaysSessions } from '../services/class-link.service';
import { istDateString } from '../services/attendance.service';

vi.mock('../utils/queues', () => ({ enqueueWhatsApp: vi.fn().mockResolvedValue(undefined) }));

const sfx = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const ids: Record<string, string> = {};
let app: any;
const tok = (userId: string, role: any) => signToken({ userId, email: `${userId}@t.test`, role });
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const TEAMS = 'https://teams.microsoft.com/l/meetup-join/abc';

beforeAll(async () => {
  app = (await import('../app')).default;
  const mk = (n: string, role: any) =>
    prisma.user.create({ data: { fullName: `T ${n} ${sfx}`, email: `${n}-${sfx}@t.test`, passwordHash: 'x', role } });
  const teacher = await mk('t', 'teacher');
  const mgr = await mk('m', 'manager');
  const course = await prisma.course.create({ data: { courseName: `C ${sfx}` } });
  const batch = await prisma.batch.create({ data: { courseId: course.id, batchName: `8-CBSE-Sci ${sfx}`, teacherId: teacher.id } });
  Object.assign(ids, { teacher: teacher.id, mgr: mgr.id, course: course.id, batch: batch.id });
});

afterAll(async () => {
  await prisma.classSession.deleteMany({ where: { batchId: ids.batch } });
  await prisma.batchSchedule.deleteMany({ where: { batchId: ids.batch } });
  await prisma.batch.delete({ where: { id: ids.batch } });
  await prisma.classLink.deleteMany({ where: { name: { contains: sfx } } });
  await prisma.course.delete({ where: { id: ids.course } });
  await prisma.user.deleteMany({ where: { id: { in: [ids.teacher, ids.mgr] } } });
  await prisma.$disconnect();
});

describe('class link library', () => {
  it('is manager-and-above only', async () => {
    expect((await request(app).get('/api/v1/class-links')).status).toBe(401);
    expect((await request(app).get('/api/v1/class-links').set(auth(tok(ids.teacher, 'teacher')))).status).toBe(403);
    expect((await request(app).get('/api/v1/class-links').set(auth(tok(ids.mgr, 'manager')))).status).toBe(200);
  });

  it('creates, rejects duplicates and non-https links, bulk-imports, updates and deletes', async () => {
    const m = auth(tok(ids.mgr, 'manager'));
    const create = await request(app).post('/api/v1/class-links').set(m).send({ name: `8th CBSE Science ${sfx}`, meetingUrl: TEAMS, grade: '8', board: 'CBSE', subject: 'Science' });
    expect(create.status).toBe(201);
    ids.link = create.body.id;
    expect((await request(app).post('/api/v1/class-links').set(m).send({ name: `8th CBSE Science ${sfx}`, meetingUrl: TEAMS })).status).toBe(409);
    expect((await request(app).post('/api/v1/class-links').set(m).send({ name: `Bad ${sfx}`, meetingUrl: 'http://insecure.example.com' })).status).toBe(400);

    const bulk = await request(app).post('/api/v1/class-links/bulk').set(m).send({
      links: [{ name: `8th CBSE Science ${sfx}`, meetingUrl: `${TEAMS}-v2` }, { name: `9th CBSE Maths ${sfx}`, meetingUrl: TEAMS }],
    });
    expect(bulk.status).toBe(201);
    expect(bulk.body).toMatchObject({ created: 1, updated: 1, total: 2 });
    expect((await prisma.classLink.findUnique({ where: { id: ids.link } }))?.meetingUrl).toBe(`${TEAMS}-v2`);
    expect((await request(app).post('/api/v1/class-links/bulk').set(m).send({ links: [{ name: `Dup ${sfx}`, meetingUrl: TEAMS }, { name: `dup ${sfx}`, meetingUrl: TEAMS }] })).status).toBe(400);

    const patch = await request(app).patch(`/api/v1/class-links/${ids.link}`).set(m).send({ meetingUrl: TEAMS });
    expect(patch.status).toBe(200);
    const other = await prisma.classLink.findFirstOrThrow({ where: { name: `9th CBSE Maths ${sfx}` } });
    expect((await request(app).delete(`/api/v1/class-links/${other.id}`).set(m)).status).toBe(204);
  });
});

describe('batch link, schedule and sessions', () => {
  it('attaches the link and weekly schedule to a batch (managers only)', async () => {
    const m = auth(tok(ids.mgr, 'manager'));
    expect((await request(app).patch(`/api/v1/academic/batches/${ids.batch}`).set(auth(tok(ids.teacher, 'teacher'))).send({ classLinkId: ids.link })).status).toBe(403);
    const ok = await request(app).patch(`/api/v1/academic/batches/${ids.batch}`).set(m).send({ classLinkId: ids.link });
    expect(ok.status).toBe(200);
    expect(ok.body.classLink.meetingUrl).toBe(TEAMS);
    expect((await request(app).patch(`/api/v1/academic/batches/${ids.batch}`).set(m).send({ classLinkId: '00000000-0000-4000-8000-000000000000' })).status).toBe(400);

    const today = new Date(`${istDateString()}T12:00:00Z`).getUTCDay();
    const sched = await request(app).put(`/api/v1/academic/batches/${ids.batch}/schedule`).set(m).send({
      slots: [{ dayOfWeek: today, startTime: '17:00', durationMinutes: 45 }, { dayOfWeek: (today + 3) % 7, startTime: '17:00' }],
    });
    expect(sched.status).toBe(200);
    expect(sched.body).toHaveLength(2);
    expect((await request(app).put(`/api/v1/academic/batches/${ids.batch}/schedule`).set(m).send({ slots: [{ dayOfWeek: 1, startTime: '9:00' }] })).status).toBe(400);
    expect((await request(app).put(`/api/v1/academic/batches/${ids.batch}/schedule`).set(m).send({ slots: [{ dayOfWeek: 1, startTime: '09:00' }, { dayOfWeek: 1, startTime: '09:00' }] })).status).toBe(400);
    // restore the two-slot schedule
    await request(app).put(`/api/v1/academic/batches/${ids.batch}/schedule`).set(m).send({
      slots: [{ dayOfWeek: today, startTime: '17:00', durationMinutes: 45 }, { dayOfWeek: (today + 3) % 7, startTime: '17:00' }],
    });
  });

  it("a teacher's session defaults to the batch's standing link", async () => {
    const t = auth(tok(ids.teacher, 'teacher'));
    const startsAt = new Date(Date.now() + 3600e3).toISOString();
    const res = await request(app).post('/api/v1/sessions').set(t).send({ batchId: ids.batch, startsAt, topic: 'Extra class' });
    expect(res.status).toBe(201);
    expect(res.body.meetingUrl).toBe(TEAMS);
    await prisma.classSession.delete({ where: { id: res.body.id } });
  });

  it('refuses a session when the batch has neither a link nor a pasted URL', async () => {
    const course = await prisma.course.findUniqueOrThrow({ where: { id: ids.course } });
    const bare = await prisma.batch.create({ data: { courseId: course.id, batchName: `bare ${sfx}`, teacherId: ids.teacher } });
    const res = await request(app).post('/api/v1/sessions').set(auth(tok(ids.teacher, 'teacher'))).send({ batchId: bare.id, startsAt: new Date().toISOString() });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no class link/i);
    await prisma.batch.delete({ where: { id: bare.id } });
  });

  it("materialises today's scheduled slot once, using the standing link, and not again", async () => {
    await prisma.classSession.deleteMany({ where: { batchId: ids.batch } });
    const now = new Date();
    expect(await materializeTodaysSessions(now)).toBeGreaterThanOrEqual(1);
    const rows = await prisma.classSession.findMany({ where: { batchId: ids.batch } });
    expect(rows).toHaveLength(1); // only today's slot, not the one three days ahead
    expect(rows[0]).toMatchObject({ meetingUrl: TEAMS, durationMinutes: 45 });
    expect(rows[0].startsAt.toISOString()).toBe(new Date(`${istDateString(now)}T17:00:00+05:30`).toISOString());
    await materializeTodaysSessions(now);
    expect(await prisma.classSession.count({ where: { batchId: ids.batch } })).toBe(1);
  });

  it('skips a slot a teacher already covered with a one-off session, and ignores inactive links', async () => {
    await prisma.classSession.deleteMany({ where: { batchId: ids.batch } });
    const slot = new Date(`${istDateString()}T17:10:00+05:30`);
    await prisma.classSession.create({ data: { batchId: ids.batch, startsAt: slot, meetingUrl: 'https://example.com/custom', topic: 'Special' } });
    await materializeTodaysSessions();
    expect(await prisma.classSession.count({ where: { batchId: ids.batch } })).toBe(1);

    await prisma.classSession.deleteMany({ where: { batchId: ids.batch } });
    await prisma.classLink.update({ where: { id: ids.link }, data: { isActive: false } });
    await materializeTodaysSessions();
    expect(await prisma.classSession.count({ where: { batchId: ids.batch } })).toBe(0);
    await prisma.classLink.update({ where: { id: ids.link }, data: { isActive: true } });
  });
});
