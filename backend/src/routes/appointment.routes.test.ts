import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { UserRole } from '@prisma/client';
import app from '../app';
import { prisma } from '../utils/database';
import { signToken } from '../utils/jwt';

const sfx = randomUUID().slice(0, 8);
const auth = () => ({ Authorization: `Bearer ${signToken({ userId: randomUUID(), email: 'm@x.in', role: UserRole.manager })}` });
const teacherAuth = () => ({ Authorization: `Bearer ${signToken({ userId: randomUUID(), email: 't@x.in', role: UserRole.teacher })}` });

// Fixed "now": 2030-01-10 13:30 IST (08:00Z). Only Date is faked.
const DAY = '2030-01-10';
let parentId: string;
let leadId: string;
const apptIds: string[] = [];

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2030-01-10T08:00:00Z'));
  const parent = await prisma.parent.create({ data: { fullName: `Appt Parent ${sfx}`, whatsappNumber: `9${Date.now()}`.slice(0, 15) } });
  parentId = parent.id;
  leadId = (await prisma.lead.create({ data: { parentId, status: 'qualified' } })).id;
});

afterAll(async () => {
  vi.useRealTimers();
  await prisma.appointment.deleteMany({ where: { leadId } });
  await prisma.lead.deleteMany({ where: { parentId } });
  await prisma.parent.delete({ where: { id: parentId } });
});

describe('appointments', () => {
  it('denies teachers', async () => {
    const res = await request(app).get('/api/v1/appointments').set(teacherAuth());
    expect(res.status).toBe(403);
  });

  it('rejects a malformed date', async () => {
    const res = await request(app).get('/api/v1/appointments/check-calendar?date=2030-02-30').set(auth());
    expect(res.status).toBe(400);
  });

  it('builds slots in IST (10:00 IST = 04:30Z) regardless of server timezone', async () => {
    const res = await request(app).get('/api/v1/appointments/check-calendar?date=2030-01-11').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.availableSlots.map((s: any) => s.time)).toEqual(['10:00', '11:30', '14:00', '15:30', '17:00', '18:30']);
    expect(res.body.availableSlots[0].iso).toBe('2030-01-11T04:30:00.000Z');
    expect(res.body.availableSlots[5].iso).toBe('2030-01-11T13:00:00.000Z');
  });

  it('excludes past slots for today (it is 13:30 IST)', async () => {
    const res = await request(app).get(`/api/v1/appointments/check-calendar?date=${DAY}`).set(auth());
    expect(res.body.availableSlots.map((s: any) => s.time)).toEqual(['14:00', '15:30', '17:00', '18:30']);
  });

  it('books, blocks overlaps with 409, and hides the booked slot', async () => {
    const book = await request(app).post('/api/v1/appointments').set(auth())
      .send({ leadId, scheduledAt: '2030-01-10T14:00:00+05:30', durationMinutes: 30 });
    expect(book.status).toBe(201);
    apptIds.push(book.body.id);
    expect((await prisma.lead.findUnique({ where: { id: leadId } }))!.status).toBe('demo_scheduled');

    // 14:15 IST overlaps the 14:00-14:30 booking
    const clash = await request(app).post('/api/v1/appointments').set(auth())
      .send({ leadId, scheduledAt: '2030-01-10T08:45:00Z', durationMinutes: 30 });
    expect(clash.status).toBe(409);

    const cal = await request(app).get(`/api/v1/appointments/check-calendar?date=${DAY}`).set(auth());
    expect(cal.body.availableSlots.map((s: any) => s.time)).not.toContain('14:00');
    expect(cal.body.bookedCount).toBe(1);
  });

  it('rejects past times, unknown leads and bad payloads', async () => {
    const past = await request(app).post('/api/v1/appointments').set(auth()).send({ leadId, scheduledAt: '2030-01-10T10:00:00+05:30' });
    expect(past.status).toBe(400);
    const noLead = await request(app).post('/api/v1/appointments').set(auth()).send({ leadId: randomUUID(), scheduledAt: '2030-01-10T17:00:00+05:30' });
    expect(noLead.status).toBe(404);
    const naive = await request(app).post('/api/v1/appointments').set(auth()).send({ leadId, scheduledAt: '2030-01-10T17:00:00' });
    expect(naive.status).toBe(400);
  });

  it('validates status and returns the lead to follow_up when the only demo is cancelled', async () => {
    const bad = await request(app).patch(`/api/v1/appointments/${apptIds[0]}/status`).set(auth()).send({ status: 'bogus' });
    expect(bad.status).toBe(400);
    const missing = await request(app).patch(`/api/v1/appointments/${randomUUID()}/status`).set(auth()).send({ status: 'cancelled' });
    expect(missing.status).toBe(404);

    const ok = await request(app).patch(`/api/v1/appointments/${apptIds[0]}/status`).set(auth()).send({ status: 'cancelled' });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('cancelled');
    expect((await prisma.lead.findUnique({ where: { id: leadId } }))!.status).toBe('follow_up');

    // cancelled appointment no longer blocks the slot
    const cal = await request(app).get(`/api/v1/appointments/check-calendar?date=${DAY}`).set(auth());
    expect(cal.body.availableSlots.map((s: any) => s.time)).toContain('14:00');
  });

  it('keeps demo_scheduled when another active appointment remains', async () => {
    const a = await request(app).post('/api/v1/appointments').set(auth()).send({ leadId, scheduledAt: '2030-01-10T15:30:00+05:30' });
    const b = await request(app).post('/api/v1/appointments').set(auth()).send({ leadId, scheduledAt: '2030-01-10T17:00:00+05:30' });
    expect([a.status, b.status]).toEqual([201, 201]);
    await request(app).patch(`/api/v1/appointments/${a.body.id}/status`).set(auth()).send({ status: 'cancelled' });
    expect((await prisma.lead.findUnique({ where: { id: leadId } }))!.status).toBe('demo_scheduled');
  });

  it('only one of two concurrent identical bookings wins', async () => {
    const body = { leadId, scheduledAt: '2030-01-10T18:30:00+05:30' };
    const [r1, r2] = await Promise.all([
      request(app).post('/api/v1/appointments').set(auth()).send(body),
      request(app).post('/api/v1/appointments').set(auth()).send(body),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([201, 409]);
  });
});
