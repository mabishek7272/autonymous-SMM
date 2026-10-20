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
const TEAMS_A = `https://teams.microsoft.com/meet/${sfx}111?p=a`;
const TEAMS_B = `https://teams.microsoft.com/meet/${sfx}222?p=b`;
const MEET = `https://meet.google.com/${sfx}-abc`;
const phoneBase = (Date.now() % 90000000) + 10000000; // 8 digits
const ph = (n: number) => `98${phoneBase}`.slice(0, 8) + String(n).padStart(2, '0');

beforeAll(async () => {
  app = (await import('../app')).default;
  const mgr = await prisma.user.create({ data: { fullName: `M ${sfx}`, email: `m-${sfx}@t.test`, passwordHash: 'x', role: 'manager' } });
  const teacher = await prisma.user.create({ data: { fullName: `T ${sfx}`, email: `t-${sfx}@t.test`, passwordHash: 'x', role: 'teacher' } });
  Object.assign(ids, { mgr: mgr.id, teacher: teacher.id });
});

afterAll(async () => {
  const batches = await prisma.batch.findMany({ where: { batchName: { contains: sfx } }, select: { id: true } });
  const bids = batches.map((b) => b.id);
  await prisma.classSession.deleteMany({ where: { batchId: { in: bids } } });
  await prisma.batchSchedule.deleteMany({ where: { batchId: { in: bids } } });
  await prisma.batch.deleteMany({ where: { id: { in: bids } } });
  await prisma.classLink.deleteMany({ where: { meetingUrl: { in: [TEAMS_A, TEAMS_B, MEET] } } });
  await prisma.course.deleteMany({ where: { courseName: `Class XII`, batches: { none: {} } } });
  const parents = await prisma.parent.findMany({ where: { fullName: { contains: sfx } }, select: { id: true } });
  await prisma.lead.deleteMany({ where: { parentId: { in: parents.map((p) => p.id) } } });
  await prisma.parent.deleteMany({ where: { id: { in: parents.map((p) => p.id) } } });
  await prisma.user.deleteMany({ where: { id: { in: [ids.mgr, ids.teacher] } } });
  await prisma.$disconnect();
});

describe('timetable import', () => {
  const rows = (extra: any[] = []) => [
    { batchName: `XII Math ${sfx}`, day: 'Monday', startTime: '7:30 PM', endTime: '8:30 PM', meetingUrl: TEAMS_A },
    { batchName: `XII Math ${sfx}`, day: 'Wednesday', startTime: '7:30 PM', endTime: '8:30 PM', meetingUrl: TEAMS_A },
    { batchName: `XII Math ${sfx}`, day: 'Friday', startTime: '7:30 PM', endTime: '8:30 PM', meetingUrl: MEET }, // same class, different room
    { batchName: `XII 1-1 Chem ${sfx}`, day: 'Monday', startTime: '6:30 PM', endTime: '7:30 PM', meetingUrl: TEAMS_B },
    { batchName: `X Bio ${sfx}`, day: 'Friday', startTime: '6:00 AM', endTime: '7:00 AM', meetingUrl: TEAMS_B }, // link shared by two batches
    ...extra,
  ];
  const post = (body: any, who = tok(ids.mgr, 'manager')) => request(app).post('/api/v1/class-links/timetable-import').set(auth(who)).send(body);

  it('is manager-and-above only', async () => {
    expect((await post({ rows: rows() }, tok(ids.teacher, 'teacher'))).status).toBe(403);
  });

  it('rejects the whole import and writes nothing when a row is bad', async () => {
    const res = await post({ rows: rows([{ batchName: `Bad ${sfx}`, day: 'Funday', startTime: '7 PM', meetingUrl: TEAMS_A }, { batchName: `Bad2 ${sfx}`, day: 'Monday', startTime: '7 PM', endTime: '6 PM', meetingUrl: TEAMS_A }]) });
    expect(res.status).toBe(400);
    expect(res.body.errors.map((e: any) => e.row)).toEqual([6, 7]);
    expect(await prisma.batch.count({ where: { batchName: { contains: sfx } } })).toBe(0);
  });

  it('dry run reports what would happen without writing', async () => {
    const res = await post({ rows: rows(), dryRun: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ dryRun: true, batches: 3, batchesToCreate: 3, links: 3, linksToCreate: 3, slots: 5 });
    expect(await prisma.batch.count({ where: { batchName: { contains: sfx } } })).toBe(0);
  });

  it('creates courses, batches, shared links, a standing link per batch and slot-level overrides', async () => {
    const res = await post({ rows: rows() });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ batches: 3, batchesToCreate: 3, links: 3, slots: 5 });

    const math = await prisma.batch.findFirstOrThrow({
      where: { batchName: `XII Math ${sfx}` },
      include: { course: true, classLink: true, schedules: { include: { classLink: true }, orderBy: { dayOfWeek: 'asc' } } },
    });
    ids.mathBatch = math.id;
    expect(math.course.courseName).toBe('Class XII');
    expect(math.classLink?.meetingUrl).toBe(TEAMS_A); // most-used link becomes the batch's standing link
    expect(math.schedules.map((s) => [s.dayOfWeek, s.startTime, s.durationMinutes, s.classLink?.meetingUrl ?? null])).toEqual([
      [1, '19:30', 60, null],
      [3, '19:30', 60, null],
      [5, '19:30', 60, MEET], // Friday uses the Google Meet room
    ]);
    // one library row for the room two batches share
    expect(await prisma.classLink.count({ where: { meetingUrl: TEAMS_B } })).toBe(1);
    const bio = await prisma.batch.findFirstOrThrow({ where: { batchName: `X Bio ${sfx}` }, include: { course: true } });
    expect(bio.course.courseName).toBe('Class X');
  });

  it('re-importing is idempotent: no duplicates, timetable replaced', async () => {
    const before = await prisma.classLink.count({ where: { meetingUrl: { in: [TEAMS_A, TEAMS_B, MEET] } } });
    const res = await post({ rows: rows().slice(0, 4) }); // drops X Bio
    expect(res.status).toBe(201);
    expect(res.body.batchesToCreate).toBe(0);
    expect(res.body.linksToCreate).toBe(0);
    expect(await prisma.classLink.count({ where: { meetingUrl: { in: [TEAMS_A, TEAMS_B, MEET] } } })).toBe(before);
    expect(await prisma.batch.count({ where: { batchName: `XII Math ${sfx}` } })).toBe(1);
    // batches not in the import keep their timetable
    expect(await prisma.batchSchedule.count({ where: { batch: { batchName: `X Bio ${sfx}` } } })).toBe(1);
  });

  it("the scheduler uses a slot's own link over the batch's standing link", async () => {
    const today = istDateString();
    const dow = new Date(`${today}T12:00:00Z`).getUTCDay();
    const math = ids.mathBatch;
    await prisma.batchSchedule.deleteMany({ where: { batchId: math } });
    const meetLink = await prisma.classLink.findFirstOrThrow({ where: { meetingUrl: MEET } });
    await prisma.batchSchedule.create({ data: { batchId: math, dayOfWeek: dow, startTime: '19:30', durationMinutes: 60, classLinkId: meetLink.id } });
    await prisma.classSession.deleteMany({ where: { batchId: math } });
    await materializeTodaysSessions();
    const s = await prisma.classSession.findFirstOrThrow({ where: { batchId: math } });
    expect(s.meetingUrl).toBe(MEET);
  });
});

describe('lead sheet import', () => {
  const post = (body: any) => request(app).post('/api/v1/leads/import').set(auth(tok(ids.mgr, 'manager'))).send(body);
  const sheet = () => [
    { name: `Chithraa ${sfx}`, grade: '10', board: 'CBSE', phone: ph(1), timeline: 'Within 1 Week', notes: 'Call again on Wednesday' },
    { name: `Selvanayaki ${sfx}`, grade: '10', board: 'CBSE', phone: ph(2), timeline: 'Within 1 Week', notes: 'Demo at 6:30 PM', remarks: 'Enrolled Successfully' },
    { name: `Salman ${sfx}`, grade: '10', board: 'Matric', phone: ph(3), timeline: 'Just Enquiring', notes: "Can't afford" },
    { name: `Sudha ${sfx}`, grade: '10', board: 'CBSE', phone: `${ph(4)} / ${ph(5)}`, timeline: 'Immediately', notes: 'Discuss and tell' },
    { name: `Nophone ${sfx}`, grade: '12', board: 'CBSE', phone: 'abc', timeline: 'Just Enquiring' },
    { name: `Chithraa again ${sfx}`, grade: '10', board: 'CBSE', phone: ph(1) }, // same number + class + board
    { name: `Chithraa elder ${sfx}`, grade: '12', board: 'CBSE', phone: ph(1) }, // same number, other class -> new lead
  ];

  it('requires leads:manage', async () => {
    expect((await request(app).post('/api/v1/leads/import').set(auth(tok(ids.teacher, 'teacher'))).send({ rows: sheet() })).status).toBe(403);
  });

  it('dry run previews counts, statuses and problems without writing', async () => {
    const res = await post({ rows: sheet(), dryRun: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ dryRun: true, created: 5, skippedDuplicates: 1, newParents: 4 });
    expect(res.body.byStatus).toMatchObject({ follow_up: 2, converted: 1, lost: 1, enquiry: 1 });
    expect(res.body.invalid).toHaveLength(1);
    expect(res.body.invalid[0].row).toBe(5);
    expect(await prisma.parent.count({ where: { fullName: { contains: sfx } } })).toBe(0);
  });

  it('imports leads with inferred stages, timelines and parents, and is idempotent', async () => {
    const res = await post({ rows: sheet() });
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(5);

    const sel = await prisma.lead.findFirstOrThrow({ where: { parent: { fullName: `Selvanayaki ${sfx}` } }, include: { parent: true } });
    expect(sel).toMatchObject({ status: 'converted', timeline: 'within_week', gradeInterested: '10', boardInterested: 'CBSE', requirements: 'Demo at 6:30 PM', notes: 'Enrolled Successfully' });
    expect(sel.parent.whatsappNumber).toBe(`91${ph(2)}`);

    const multi = await prisma.lead.findFirstOrThrow({ where: { parent: { fullName: `Sudha ${sfx}` } } });
    expect(multi.notes).toContain(`Alt: 91${ph(5)}`);

    const sameNumber = await prisma.lead.findMany({ where: { parent: { whatsappNumber: `91${ph(1)}` } } });
    expect(sameNumber).toHaveLength(2); // grade 10 and grade 12 under one parent

    const again = await post({ rows: sheet() });
    expect(again.body.created).toBe(0);
    expect(again.body.skippedDuplicates).toBe(6);
    expect(await prisma.lead.count({ where: { parent: { fullName: { contains: sfx } } } })).toBe(5);
  });
});
