import 'dotenv/config';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';

const enqueue = vi.hoisted(() => vi.fn());
vi.mock('../utils/queues', () => ({ enqueueWhatsApp: enqueue }));

import app from '../app';
import { prisma } from '../utils/database';
import { redis, connectRedis } from '../utils/redis';
import { signToken } from '../utils/jwt';
import { renderTemplate, unknownPlaceholders, runDueRules, runRuleNow, buildTeacherData, seedDefaultReminderRule } from './reminder-rule.service';
import { dateOnly, istDayStart, withRedisLock } from './scheduler.service';

const sfx = randomUUID().slice(0, 8);
let adminToken = '';
const teacherToken = signToken({ userId: randomUUID(), email: `t-${sfx}@x.test`, role: 'teacher' });
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

// Wednesday 2026-03-04 03:17 IST == 2026-03-03T21:47:00Z
const NOW = new Date('2026-03-03T21:47:10Z');
const ids = { course: '', batch: '', tPhone: '', tNoPhone: '', parent: '', student: '' };
const ruleIds: string[] = [];
const template = `Hi {{teacherName}} [${sfx}] pending={{pendingAttendanceDays}} batches={{batchNames}} today={{sessionsToday}}`;

beforeAll(async () => {
  if (redis.status === 'wait') await connectRedis();
  ids.course = (await prisma.course.create({ data: { courseName: `REM-${sfx}` } })).id;
  const tp = await prisma.user.create({ data: { fullName: `Phoned ${sfx}`, email: `p-${sfx}@x.test`, passwordHash: 'x', role: 'teacher', phone: '9876543210' } });
  const tn = await prisma.user.create({ data: { fullName: `NoPhone ${sfx}`, email: `n-${sfx}@x.test`, passwordHash: 'x', role: 'teacher' } });
  adminToken = signToken({ userId: tn.id, email: tn.email, role: 'admin' }); // real user id: createdById is an FK
  ids.tPhone = tp.id; ids.tNoPhone = tn.id;
  ids.batch = (await prisma.batch.create({ data: { courseId: ids.course, batchName: `RB-${sfx}`, teacherId: tp.id } })).id;
  ids.parent = (await prisma.parent.create({ data: { fullName: `RP ${sfx}`, whatsappNumber: '8' + String(Math.floor(Math.random() * 1e11)).padStart(11, '0') } })).id;
  ids.student = (await prisma.student.create({ data: { fullName: `RS ${sfx}`, parentId: ids.parent } })).id;
  await prisma.enrollment.create({ data: { studentId: ids.student, batchId: ids.batch } });
  // Window is 2026-02-25 .. 2026-03-03. Attendance marked on Mon 03-02 only; one session today (03-04 10:00 IST).
  await prisma.attendance.create({ data: { studentId: ids.student, batchId: ids.batch, date: dateOnly('2026-03-02'), status: 'present' } });
  await prisma.classSession.create({ data: { batchId: ids.batch, startsAt: new Date(istDayStart('2026-03-04').getTime() + 10 * 3600_000), meetingUrl: 'https://meet.test/x' } });
});

afterAll(async () => {
  await prisma.message.deleteMany({ where: { body: { contains: sfx } } });
  await prisma.aiActivityLog.deleteMany({ where: { targetId: { in: [...ruleIds, ids.tPhone, ids.tNoPhone] } } });
  await prisma.reminderRule.deleteMany({ where: { id: { in: ruleIds } } });
  await prisma.classSession.deleteMany({ where: { batchId: ids.batch } });
  await prisma.attendance.deleteMany({ where: { studentId: ids.student } });
  await prisma.enrollment.deleteMany({ where: { studentId: ids.student } });
  await prisma.student.deleteMany({ where: { id: ids.student } });
  await prisma.parent.deleteMany({ where: { id: ids.parent } });
  await prisma.batch.deleteMany({ where: { id: ids.batch } });
  await prisma.course.deleteMany({ where: { id: ids.course } });
  await prisma.user.deleteMany({ where: { id: { in: [ids.tPhone, ids.tNoPhone] } } });
  await prisma.$disconnect();
});

beforeEach(() => {
  enqueue.mockReset();
  enqueue.mockResolvedValue(undefined);
});

describe('template rendering', () => {
  it('replaces known placeholders and detects unknown ones', () => {
    expect(renderTemplate('{{teacherName}}: {{pendingAttendanceDays}} / {{batchNames}} / {{sessionsToday}} {{other}}',
      { teacherName: 'Ravi', pendingAttendanceDays: 2, batchNames: 'A, B', sessionsToday: 1 })).toBe('Ravi: 2 / A, B / 1 {{other}}');
    expect(unknownPlaceholders('{{teacherName}} {{foo}} {{ bar }}')).toEqual(['foo', 'bar']);
  });

  it('computes real per-teacher data', async () => {
    const data = await buildTeacherData({ id: ids.tPhone, fullName: 'Phoned' }, NOW);
    // 02-25 Wed, 02-26 Thu, 02-27 Fri, 02-28 Sat, (03-01 Sun skipped), 03-02 marked, 03-03 Tue -> 5 unmarked days
    // Its only session is today, so no past session days exist -> treated as meeting Mon-Sat.
    expect(data).toEqual({ teacherName: 'Phoned', pendingAttendanceDays: 5, batchNames: `RB-${sfx}`, sessionsToday: 1 });
    const none = await buildTeacherData({ id: ids.tNoPhone, fullName: 'NoPhone' }, NOW);
    expect(none).toMatchObject({ pendingAttendanceDays: 0, sessionsToday: 0 });
  });
});

describe('rule runner', () => {
  it('runs due rules once per minute, skipping teachers without a phone', async () => {
    const rule = await prisma.reminderRule.create({ data: { name: `due-${sfx}`, audience: 'teacher', dayOfWeek: 3, timeOfDay: '03:17', template } });
    ruleIds.push(rule.id);

    const first = (await runDueRules(NOW)).find((r) => r.ruleId === rule.id)!;
    expect(first).toBeTruthy();
    expect(first.skipped.some((s) => s.teacherId === ids.tNoPhone && /phone/i.test(s.reason))).toBe(true);
    const call = enqueue.mock.calls.map((c) => c[0]).find((c) => c.targetId === ids.tPhone);
    expect(call.to).toBe('919876543210');
    expect(call.text).toBe(`Hi Phoned ${sfx} [${sfx}] pending=5 batches=RB-${sfx} today=1`);
    expect(await prisma.message.count({ where: { body: { contains: `Phoned ${sfx}` } } })).toBe(1);
    expect((await prisma.reminderRule.findUnique({ where: { id: rule.id } }))!.lastRunAt).toBeTruthy();

    // Same minute again: no double send
    enqueue.mockClear();
    expect((await runDueRules(new Date(NOW.getTime() + 15_000))).find((r) => r.ruleId === rule.id)).toBeUndefined();
    expect(enqueue).not.toHaveBeenCalled();

    // Disabled / different minute do not run
    await prisma.reminderRule.update({ where: { id: rule.id }, data: { lastRunAt: null, enabled: false } });
    expect((await runDueRules(NOW)).find((r) => r.ruleId === rule.id)).toBeUndefined();
    await prisma.reminderRule.update({ where: { id: rule.id }, data: { enabled: true } });
    expect((await runDueRules(new Date(NOW.getTime() + 120_000))).find((r) => r.ruleId === rule.id)).toBeUndefined();
  });

  it('reports a failed send honestly', async () => {
    const rule = await prisma.reminderRule.create({ data: { name: `fail-${sfx}`, audience: 'teacher', dayOfWeek: 1, timeOfDay: '04:00', template } });
    ruleIds.push(rule.id);
    enqueue.mockRejectedValue(new Error('queue down'));
    const res = (await runRuleNow(rule.id))!;
    expect(res.sent).toBe(0);
    expect(res.failed.some((f) => f.teacherId === ids.tPhone && f.error === 'queue down')).toBe(true);
  });

  it('seeds the default rule only when no rules exist', async () => {
    expect(await seedDefaultReminderRule()).toBeNull(); // our test rules exist
  });
});

describe('redis lock', () => {
  it('does not run the function when the lock is already held', async () => {
    const key = `test-${sfx}`;
    const outer = await withRedisLock(key, 10, async () => {
      const inner = await withRedisLock(key, 10, async () => 'inner');
      return inner.acquired;
    });
    expect(outer).toEqual({ acquired: true, result: false });
    expect((await withRedisLock(key, 10, async () => 1)).acquired).toBe(true); // released afterwards
  });
});

describe('reminder routes', () => {
  it('enforces permission', async () => {
    expect((await request(app).get('/api/v1/reminders')).status).toBe(401);
    expect((await request(app).get('/api/v1/reminders').set(auth(teacherToken))).status).toBe(403);
  });

  it('validates input', async () => {
    const post = (b: object) => request(app).post('/api/v1/reminders').set(auth(adminToken)).send(b);
    const ok = { name: `n-${sfx}`, audience: 'teacher', dayOfWeek: 1, timeOfDay: '09:00', template: 'Hi {{teacherName}}' };
    expect((await post({ ...ok, timeOfDay: '9:00' })).status).toBe(400);
    expect((await post({ ...ok, timeOfDay: '24:00' })).status).toBe(400);
    expect((await post({ ...ok, dayOfWeek: 7 })).status).toBe(400);
    expect((await post({ ...ok, audience: 'student' })).status).toBe(400);
    const unk = await post({ ...ok, template: 'Hi {{nope}}' });
    expect(unk.status).toBe(400);
    expect(JSON.stringify(unk.body)).toContain('nope');
    expect((await request(app).get('/api/v1/reminders/xyz').set(auth(adminToken))).status).toBe(400);
    expect((await request(app).get(`/api/v1/reminders/${randomUUID()}`).set(auth(adminToken))).status).toBe(404);
  });

  it('supports CRUD and run-now', async () => {
    const created = await request(app).post('/api/v1/reminders').set(auth(adminToken))
      .send({ name: `crud-${sfx}`, audience: 'teacher', dayOfWeek: 2, timeOfDay: '05:30', template });
    expect(created.status).toBe(201);
    expect(created.body.enabled).toBe(true);
    const id = created.body.id as string;
    ruleIds.push(id);

    const patched = await request(app).patch(`/api/v1/reminders/${id}`).set(auth(adminToken)).send({ enabled: false, timeOfDay: '06:00' });
    expect(patched.body).toMatchObject({ enabled: false, timeOfDay: '06:00' });
    expect((await request(app).patch(`/api/v1/reminders/${id}`).set(auth(adminToken)).send({})).status).toBe(400);

    const list = await request(app).get('/api/v1/reminders').set(auth(adminToken));
    expect(list.body.some((r: any) => r.id === id)).toBe(true);

    const run = await request(app).post(`/api/v1/reminders/${id}/run-now`).set(auth(adminToken));
    expect(run.status).toBe(200);
    expect(run.body.sent).toBeGreaterThanOrEqual(1);
    expect((await request(app).post(`/api/v1/reminders/${randomUUID()}/run-now`).set(auth(adminToken))).status).toBe(404);

    expect((await request(app).delete(`/api/v1/reminders/${id}`).set(auth(adminToken))).status).toBe(204);
    expect((await request(app).delete(`/api/v1/reminders/${id}`).set(auth(adminToken))).status).toBe(404);
  });
});
