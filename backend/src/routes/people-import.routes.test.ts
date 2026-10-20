import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { prisma } from '../utils/database';
import { signToken } from '../utils/jwt';
import { parseFlexibleDate, splitBatchNames } from '../services/people-import.service';

vi.mock('../utils/queues', () => ({ enqueueWhatsApp: vi.fn().mockResolvedValue(undefined) }));

const sfx = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const ids: Record<string, string> = {};
let app: any;
const tok = (userId: string, role: any) => signToken({ userId, email: `${userId}@t.test`, role });
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const base = (Date.now() % 9000000) + 1000000; // 7 digits
const ph = (n: number) => `9${base}${String(n).padStart(2, '0')}`; // always 10 digits
const emailOf = (n: string) => `${n}-${sfx}@imp.test`;

beforeAll(async () => {
  app = (await import('../app')).default;
  const mk = (n: string, role: any) => prisma.user.create({ data: { fullName: `U ${n} ${sfx}`, email: emailOf(`u-${n}`), passwordHash: 'x', role } });
  const [admin, manager, teacher] = await Promise.all([mk('admin', 'admin'), mk('manager', 'manager'), mk('teacher', 'teacher')]);
  const course = await prisma.course.create({ data: { courseName: `Imp ${sfx}` } });
  const b1 = await prisma.batch.create({ data: { courseId: course.id, batchName: `XII Chem ${sfx}` } });
  const b2 = await prisma.batch.create({ data: { courseId: course.id, batchName: `XII Math ${sfx}` } });
  const taken = await prisma.batch.create({ data: { courseId: course.id, batchName: `X Bio ${sfx}`, teacherId: teacher.id } });
  Object.assign(ids, { admin: admin.id, manager: manager.id, teacher: teacher.id, course: course.id, b1: b1.id, b2: b2.id, taken: taken.id });
});

afterAll(async () => {
  const students = await prisma.student.findMany({ where: { fullName: { contains: sfx } }, select: { id: true } });
  await prisma.enrollment.deleteMany({ where: { studentId: { in: students.map((s) => s.id) } } });
  await prisma.student.deleteMany({ where: { id: { in: students.map((s) => s.id) } } });
  await prisma.parent.deleteMany({ where: { fullName: { contains: sfx } } });
  await prisma.batch.deleteMany({ where: { courseId: ids.course } });
  await prisma.course.delete({ where: { id: ids.course } });
  await prisma.user.deleteMany({ where: { email: { endsWith: `-${sfx}@imp.test` } } });
  await prisma.$disconnect();
});

describe('helpers', () => {
  it('splits batch lists and reads dates', () => {
    expect(splitBatchNames('XII Chem; XII Math;;xii chem\nX Bio')).toEqual(['XII Chem', 'XII Math', 'X Bio']);
    expect(splitBatchNames('')).toEqual([]);
    expect(parseFlexibleDate('2008-03-09')?.toISOString()).toBe('2008-03-09T00:00:00.000Z');
    expect(parseFlexibleDate('09/03/2008')?.toISOString()).toBe('2008-03-09T00:00:00.000Z');
    expect(parseFlexibleDate('9-3-2008')?.toISOString()).toBe('2008-03-09T00:00:00.000Z');
    expect(parseFlexibleDate('31/02/2008')).toBeNull();
    expect(parseFlexibleDate('soon')).toBeNull();
  });
});

describe('teacher import', () => {
  const post = (rows: any[], who = tok(ids.admin, 'admin'), dryRun?: boolean) =>
    request(app).post('/api/v1/users/import').set(auth(who)).send({ rows, dryRun });
  const rows = () => [
    { fullName: `Priya ${sfx}`, email: emailOf('priya'), phone: ph(1), initials: 'pk', batches: `XII Chem ${sfx}; XII Math ${sfx}` },
    { fullName: `Ravi ${sfx}`, email: emailOf('ravi'), phone: `+91 ${ph(2)}`, password: 'Chosen#Pass1' },
    { fullName: `Meena ${sfx}`, email: emailOf('meena'), phone: ph(3), batches: `X Bio ${sfx}` }, // batch already has a teacher
    { fullName: `Nophone ${sfx}`, email: emailOf('nophone'), phone: 'abc' },
    { fullName: `Badbatch ${sfx}`, email: emailOf('badbatch'), phone: ph(4), batches: 'No Such Batch' },
    { fullName: 'X', email: 'not-an-email', phone: ph(5) },
  ];

  it('is for superadmin/admin only', async () => {
    expect((await post(rows(), tok(ids.manager, 'manager'))).status).toBe(403);
    expect((await post(rows(), tok(ids.teacher, 'teacher'))).status).toBe(403);
  });

  it('dry run previews and reports each problem row without writing', async () => {
    const res = await post(rows(), tok(ids.admin, 'admin'), true);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ dryRun: true, created: 3, existing: 0, batchesAssigned: 2, credentials: [] });
    expect(res.body.invalid.map((r: any) => r.row)).toEqual([4, 5, 6]);
    expect(res.body.warnings.map((w: any) => w.message).join(' ')).toMatch(/already has a teacher/);
    expect(await prisma.user.count({ where: { email: { endsWith: `-${sfx}@imp.test` }, role: 'teacher' } })).toBe(1); // only the fixture teacher
  });

  it('creates teachers, assigns batches, returns generated passwords once and they work for login', async () => {
    const res = await post(rows());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ created: 3, existing: 0, batchesAssigned: 2 });
    expect(res.body.credentials.map((c: any) => c.email).sort()).toEqual([emailOf('meena'), emailOf('priya')]); // Ravi chose his own password
    const priya = await prisma.user.findUniqueOrThrow({ where: { email: emailOf('priya') } });
    expect(priya).toMatchObject({ role: 'teacher', phone: `91${ph(1)}`, initials: 'PK' });
    expect(priya.passwordHash).not.toContain(res.body.credentials[0].password);
    expect((await prisma.batch.findMany({ where: { id: { in: [ids.b1, ids.b2] } } })).every((b) => b.teacherId === priya.id)).toBe(true);
    expect((await prisma.batch.findUniqueOrThrow({ where: { id: ids.taken } })).teacherId).toBe(ids.teacher); // untouched

    const cred = res.body.credentials.find((c: any) => c.email === emailOf('priya'));
    // Login is two-step (password, then an emailed code); a correct password gets past step 1.
    const login = await request(app).post('/api/v1/auth/login').send({ email: cred.email, password: cred.password });
    expect(login.status).toBe(200);
    expect(login.body.otpRequired).toBe(true);
    expect((await request(app).post('/api/v1/auth/login').send({ email: emailOf('ravi'), password: 'Chosen#Pass1' })).status).toBe(200);
  });

  it('is idempotent: existing teachers are not duplicated and get no new password', async () => {
    const res = await post(rows());
    expect(res.body).toMatchObject({ created: 0, existing: 3, batchesAssigned: 0, credentials: [] });
    expect(await prisma.user.count({ where: { email: emailOf('priya') } })).toBe(1);
  });

  it("rejects an email that already belongs to a non-teacher account", async () => {
    const res = await post([{ fullName: `Admin again ${sfx}`, email: emailOf('u-admin'), phone: ph(6) }]);
    expect(res.body.invalid[0].message).toMatch(/already belongs to a admin account/);
    expect(res.body.created).toBe(0);
  });
});

describe('student import and registration', () => {
  const post = (rows: any[], dryRun?: boolean, who = tok(ids.admin, 'admin')) =>
    request(app).post('/api/v1/students/import').set(auth(who)).send({ rows, dryRun });
  const rows = () => [
    { studentName: `Teja ${sfx}`, parentName: `Parent Teja ${sfx}`, parentPhone: ph(11), grade: '12', board: 'CBSE', dateOfBirth: '09/03/2008', batches: `XII Chem ${sfx}; XII Math ${sfx}` },
    { studentName: `Layana ${sfx}`, parentName: `Parent Teja ${sfx}`, parentPhone: ph(11), grade: '12', board: 'CBSE', batches: `XII Chem ${sfx}` }, // sibling, same parent
    { studentName: `Orphan ${sfx}`, parentPhone: ph(12) }, // new parent without a name
    { studentName: `Badphone ${sfx}`, parentName: 'P', parentPhone: '12' },
    { studentName: `Badbatch ${sfx}`, parentName: `Parent B ${sfx}`, parentPhone: ph(13), batches: 'Nope' },
    { studentName: `Baddate ${sfx}`, parentName: `Parent C ${sfx}`, parentPhone: ph(14), dateOfBirth: '31/02/2008' },
  ];

  it('needs students:manage', async () => {
    expect((await post(rows(), false, tok(ids.teacher, 'teacher'))).status).toBe(403);
  });

  it('dry run lists every problem row and writes nothing', async () => {
    const res = await post(rows(), true);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ dryRun: true, created: 2, existing: 0, newParents: 1, enrollmentsAdded: 3 });
    expect(res.body.invalid.map((r: any) => r.row)).toEqual([3, 4, 5, 6]);
    expect(await prisma.student.count({ where: { fullName: { contains: sfx } } })).toBe(0);
  });

  it('creates parents, students with class/board/DOB, and enrolls them in the named batches', async () => {
    const res = await post(rows());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ created: 2, newParents: 1, enrollmentsAdded: 3 });
    const teja = await prisma.student.findFirstOrThrow({
      where: { fullName: `Teja ${sfx}` },
      include: { parent: true, enrollments: { include: { batch: true } } },
    });
    expect(teja).toMatchObject({ grade: '12', board: 'CBSE', status: 'active' });
    expect(teja.dateOfBirth?.toISOString().slice(0, 10)).toBe('2008-03-09');
    expect(teja.parent.whatsappNumber).toBe(`91${ph(11)}`);
    expect(teja.enrollments.map((e) => e.batch.batchName).sort()).toEqual([`XII Chem ${sfx}`, `XII Math ${sfx}`]);
    const siblings = await prisma.student.count({ where: { parentId: teja.parentId } });
    expect(siblings).toBe(2);
  });

  it('is idempotent and only adds missing batches to an existing student', async () => {
    expect((await post(rows())).body).toMatchObject({ created: 0, existing: 2, enrollmentsAdded: 0, newParents: 0 });
    const more = await post([{ studentName: `Layana ${sfx}`, parentPhone: ph(11), batches: `XII Chem ${sfx}; XII Math ${sfx}` }]);
    expect(more.body).toMatchObject({ created: 0, existing: 1, enrollmentsAdded: 1 });
    expect(await prisma.student.count({ where: { fullName: { contains: sfx } } })).toBe(2);
  });

  it('registers a single student through /register', async () => {
    const m = auth(tok(ids.manager, 'manager'));
    const bad = await request(app).post('/api/v1/students/register').set(m).send({ studentName: `Solo ${sfx}`, parentPhone: '1' });
    expect(bad.status).toBe(400);
    const ok = await request(app).post('/api/v1/students/register').set(m).send({
      studentName: `Solo ${sfx}`, parentName: `Parent Solo ${sfx}`, parentPhone: ph(21), grade: '10', board: 'Matric', batches: `XII Math ${sfx}`,
    });
    expect(ok.status).toBe(201);
    expect(ok.body.student).toMatchObject({ fullName: `Solo ${sfx}`, grade: '10', board: 'Matric' });
    expect(ok.body.student.enrollments).toHaveLength(1);
    expect(ok.body.created).toBe(true);
  });
});

describe('change password', () => {
  it('lets a user change their own password; the old one stops working', async () => {
    const bcrypt = (await import('bcryptjs')).default;
    const u = await prisma.user.create({ data: { fullName: `Pw ${sfx}`, email: emailOf('pw'), passwordHash: await bcrypt.hash('Old#Password1', 4), role: 'teacher' } });
    const t = auth(tok(u.id, 'teacher'));
    const send = (body: any) => request(app).post('/api/v1/auth/change-password').set(t).send(body);
    expect((await request(app).post('/api/v1/auth/change-password').send({ currentPassword: 'a', newPassword: 'bbbbbbbb' })).status).toBe(401);
    expect((await send({ currentPassword: 'wrong', newPassword: 'New#Password2' })).status).toBe(400);
    expect((await send({ currentPassword: 'Old#Password1', newPassword: 'short' })).status).toBe(400);
    expect((await send({ currentPassword: 'Old#Password1', newPassword: 'Old#Password1' })).status).toBe(400);
    expect((await send({ currentPassword: 'Old#Password1', newPassword: 'New#Password2' })).status).toBe(204);
    expect((await request(app).post('/api/v1/auth/login').send({ email: emailOf('pw'), password: 'Old#Password1' })).status).toBe(401);
    expect((await request(app).post('/api/v1/auth/login').send({ email: emailOf('pw'), password: 'New#Password2' })).status).toBe(200);
  });
});
