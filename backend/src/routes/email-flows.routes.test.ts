import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { prisma } from '../utils/database';
import { signToken } from '../utils/jwt';
import { announceSession } from '../services/class-link.service';
import { istDateString } from '../services/attendance.service';

const q = vi.hoisted(() => ({ wa: vi.fn().mockResolvedValue(undefined), em: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../utils/queues', () => ({ enqueueWhatsApp: q.wa }));
vi.mock('../utils/email-queue', () => ({ enqueueEmail: q.em }));

const sfx = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const base = (Date.now() % 9000000) + 1000000;
const ph = (n: number) => `9${base}${String(n).padStart(2, '0')}`;
const ids: Record<string, string> = {};
let app: any;
const saved = { ...process.env };
const tok = (userId: string, role: any) => signToken({ userId, email: `${userId}@t.test`, role });
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const emailsOfKind = (kind: string) => q.em.mock.calls.map((c) => c[0]).filter((j) => j.kind === kind);

beforeAll(async () => {
  process.env.RESEND_API_KEY = 're_test';
  app = (await import('../app')).default;
  const mk = (n: string, role: any, extra: any = {}) => prisma.user.create({ data: { fullName: `U ${n} ${sfx}`, email: `${n}-${sfx}@mail.test`, passwordHash: 'x', role, ...extra } });
  const admin = await mk('admin', 'admin');
  const teacher = await mk('teacher', 'teacher', { phone: `91${ph(1)}` });
  const other = await mk('other', 'teacher');
  const course = await prisma.course.create({ data: { courseName: `EF ${sfx}` } });
  const batch = await prisma.batch.create({ data: { courseId: course.id, batchName: `XII Chem ${sfx}`, teacherId: teacher.id } });
  const p1 = await prisma.parent.create({ data: { fullName: `P1 ${sfx}`, whatsappNumber: `91${ph(2)}`, email: `p1-${sfx}@mail.test` } });
  const p2 = await prisma.parent.create({ data: { fullName: `P2 ${sfx}`, whatsappNumber: `91${ph(3)}`, email: `p2-${sfx}@mail.test`, optedOut: true } });
  const s1 = await prisma.student.create({ data: { parentId: p1.id, fullName: `Absent One ${sfx}` } });
  const s2 = await prisma.student.create({ data: { parentId: p2.id, fullName: `Absent Two ${sfx}` } });
  const s3 = await prisma.student.create({ data: { parentId: p1.id, fullName: `Present ${sfx}` } });
  for (const s of [s1, s2, s3]) await prisma.enrollment.create({ data: { studentId: s.id, batchId: batch.id } });
  Object.assign(ids, { admin: admin.id, teacher: teacher.id, other: other.id, course: course.id, batch: batch.id, p1: p1.id, p2: p2.id, s1: s1.id, s2: s2.id, s3: s3.id });
});

afterAll(async () => {
  process.env = { ...saved };
  await prisma.aiActivityLog.deleteMany({ where: { OR: [{ agentId: 'attendance-notifier', targetId: { contains: sfx } }, { targetId: { in: [ids.s1, ids.s2, ids.s3].map((s) => `${s}:${istDateString()}`) } }] } });
  await prisma.message.deleteMany({ where: { parentId: { in: [ids.p1, ids.p2] } } });
  await prisma.classSession.deleteMany({ where: { batchId: ids.batch } });
  await prisma.attendance.deleteMany({ where: { batchId: ids.batch } });
  await prisma.enrollment.deleteMany({ where: { batchId: ids.batch } });
  await prisma.student.deleteMany({ where: { id: { in: [ids.s1, ids.s2, ids.s3] } } });
  await prisma.parent.deleteMany({ where: { id: { in: [ids.p1, ids.p2] } } });
  await prisma.batch.delete({ where: { id: ids.batch } });
  await prisma.course.delete({ where: { id: ids.course } });
  await prisma.user.deleteMany({ where: { email: { endsWith: `-${sfx}@mail.test` } } });
  await prisma.$disconnect();
});
beforeEach(() => { vi.clearAllMocks(); process.env.RESEND_API_KEY = 're_test'; });
afterEach(() => undefined);

describe('absence notices', () => {
  const today = istDateString();
  const url = () => `/api/v1/attendance/batches/${ids.batch}/notify-absent`;

  it('notifies parents of absent students by WhatsApp and email, once per student per day', async () => {
    const t = auth(tok(ids.teacher, 'teacher'));
    await request(app).post(`/api/v1/attendance/batches/${ids.batch}`).set(t).send({
      date: today,
      entries: [{ studentId: ids.s1, status: 'absent' }, { studentId: ids.s2, status: 'absent' }, { studentId: ids.s3, status: 'present' }],
    });
    const first = await request(app).post(url()).set(t).send({ date: today });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ absent: 2, notified: 1, alreadyNotified: 0, skippedOptedOut: 1, noContact: 0, failed: 0 });
    expect(q.wa).toHaveBeenCalledTimes(1);
    expect(q.wa.mock.calls[0][0].text).toContain(`Absent One ${sfx}`);
    const mails = emailsOfKind('reports');
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: `p1-${sfx}@mail.test`, subject: expect.stringContaining('was absent') });

    const again = await request(app).post(url()).set(t).send({ date: today });
    expect(again.body).toMatchObject({ notified: 0, alreadyNotified: 1, skippedOptedOut: 1 });
    expect(q.em).toHaveBeenCalledTimes(1); // nothing new
  });

  it("is limited to the teacher's own batch and to valid, non-future dates", async () => {
    expect((await request(app).post(url()).set(auth(tok(ids.other, 'teacher'))).send({ date: today })).status).toBe(403);
    const t = auth(tok(ids.teacher, 'teacher'));
    expect((await request(app).post(url()).set(t).send({ date: '2099-01-01' })).status).toBe(400);
    expect((await request(app).post(url()).set(t).send({ date: 'soon' })).status).toBe(400);
    expect((await request(app).post(url()).send({ date: today })).status).toBe(401);
  });
});

describe('account emails', () => {
  it('emails new teachers their temporary password from security@, and never over WhatsApp', async () => {
    const res = await request(app).post('/api/v1/users/import').set(auth(tok(ids.admin, 'admin'))).send({
      rows: [{ fullName: `Imported ${sfx}`, email: `imported-${sfx}@mail.test`, phone: ph(10) }],
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ created: 1, emailed: 1 });
    const job = emailsOfKind('security')[0];
    expect(job).toMatchObject({ to: `imported-${sfx}@mail.test`, subject: 'Your E-Kalavya account is ready' });
    expect(job.text).toContain(res.body.credentials[0].password);
    expect(q.wa).not.toHaveBeenCalled();
  });

  it('a manually created account gets a welcome email without the password', async () => {
    const res = await request(app).post('/api/v1/users').set(auth(tok(ids.admin, 'admin'))).send({
      fullName: `Manual ${sfx}`, email: `manual-${sfx}@mail.test`, password: 'Admin-Typed#123', role: 'teacher',
    });
    expect(res.status).toBe(201);
    expect(res.body.emailed).toBe(true);
    const job = emailsOfKind('security').find((j) => j.to === `manual-${sfx}@mail.test`)!;
    expect(job.text).not.toContain('Admin-Typed#123');
    expect(job.text).toContain('separately');
  });

  it('sends a security notice when a password is changed', async () => {
    const u = await prisma.user.create({ data: { fullName: `Pw ${sfx}`, email: `pw-${sfx}@mail.test`, passwordHash: await bcrypt.hash('Old#Password1', 4), role: 'teacher' } });
    const res = await request(app).post('/api/v1/auth/change-password').set(auth(tok(u.id, 'teacher'))).send({ currentPassword: 'Old#Password1', newPassword: 'New#Password2' });
    expect(res.status).toBe(204);
    const job = emailsOfKind('security').find((j) => j.to === `pw-${sfx}@mail.test`)!;
    expect(job.subject).toBe('Your E-Kalavya password was changed');
    expect(job.text).not.toContain('New#Password2');
  });
});

describe('class link announcement', () => {
  it('emails parents and the teacher the join link in addition to WhatsApp', async () => {
    const session = await prisma.classSession.create({
      data: { batchId: ids.batch, startsAt: new Date(Date.now() + 3600e3), meetingUrl: 'https://teams.microsoft.com/meet/987654321', topic: 'Revision' },
    });
    const r = await announceSession(session.id);
    expect(r).toMatchObject({ parentsMessaged: 1, parentsSkippedOptedOut: 1, teacherMessaged: true });
    const general = emailsOfKind('general');
    expect(general.map((j) => j.to).sort()).toEqual([`p1-${sfx}@mail.test`, `teacher-${sfx}@mail.test`].sort());
    const parentMail = general.find((j) => j.to.startsWith('p1-'))!;
    expect(parentMail.html).toContain('href="https://teams.microsoft.com/meet/987654321"');
    expect(parentMail.subject).toContain('Class today');
    expect(parentMail.text).toContain(`Absent One ${sfx} & Present ${sfx}`);
    // the opted-out parent gets nothing on any channel
    expect(general.some((j) => j.to.startsWith('p2-'))).toBe(false);
    expect(q.wa).toHaveBeenCalledTimes(2); // one parent + the teacher's phone
  });
});
