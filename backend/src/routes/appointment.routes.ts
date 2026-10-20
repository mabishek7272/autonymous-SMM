import { Router, Request, Response } from 'express';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { rolesWith } from '../utils/permissions';
import { prisma } from '../utils/database';
import { z } from 'zod';
import { asyncHandler } from '../utils/async-handler';
import { istDateString } from '../services/academic-monitoring.service';

const router = Router();
router.use(authenticate, authorize(...rolesWith('leads:manage')));

// ── IST helpers (India has no DST, so the offset is a fixed +05:30) ──────────
// Slot maths never touches the server's local timezone: every instant is built
// from an explicit "+05:30" timestamp and stored/compared as UTC.
export const DEMO_SLOT_TIMES = ['10:00', '11:30', '14:00', '15:30', '17:00', '18:30'] as const;
const DEFAULT_SLOT_MINUTES = 30;
const MIN_MS = 60_000;

/** UTC instant for an IST wall-clock date (YYYY-MM-DD) and time (HH:mm). */
export function istToUtc(date: string, time = '00:00'): Date {
  return new Date(`${date}T${time}:00+05:30`);
}

const DateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD').refine(
  (d) => !Number.isNaN(istToUtc(d).getTime()) && istDateString(istToUtc(d)) === d, // rejects e.g. 2026-02-30
  'invalid calendar date',
);

const CreateAppointmentSchema = z.object({
  leadId: z.string().uuid(),
  scheduledAt: z.string().datetime({ offset: true }),
  durationMinutes: z.number().int().min(10).max(240).default(DEFAULT_SLOT_MINUTES),
});

const StatusSchema = z.object({
  status: z.enum(['scheduled', 'completed', 'cancelled', 'no_show']),
});

const IdParam = z.object({ id: z.string().uuid() });

const ListQuery = z.object({
  status: z.enum(['scheduled', 'completed', 'cancelled', 'no_show']).optional(),
});

const CalendarQuery = z.object({
  date: DateOnly.optional(),
  durationMinutes: z.coerce.number().int().min(10).max(240).default(DEFAULT_SLOT_MINUTES),
});

class ConflictError extends Error {}
class NotFoundError extends Error {}

const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number) => aStart < bEnd && aEnd > bStart;

// GET /api/v1/appointments
router.get('/', asyncHandler(async (req: Request, res: Response) => {
  const parsed = ListQuery.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() }); return; }
  const appointments = await prisma.appointment.findMany({
    where: parsed.data.status ? { status: parsed.data.status } : {},
    include: { lead: { include: { parent: true } } },
    orderBy: { scheduledAt: 'asc' },
  });
  res.json(appointments);
}));

// GET /api/v1/appointments/check-calendar — AI tool: check_calendar()
router.get('/check-calendar', asyncHandler(async (req: Request, res: Response) => {
  const parsed = CalendarQuery.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() }); return; }

  const now = new Date();
  const date = parsed.data.date ?? istDateString(now);
  const { durationMinutes } = parsed.data;
  const dayStart = istToUtc(date);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * MIN_MS);

  // Anything that could overlap a slot today (look back for long appointments that started earlier).
  const existing = await prisma.appointment.findMany({
    where: {
      status: { not: 'cancelled' },
      scheduledAt: { gte: new Date(dayStart.getTime() - 4 * 60 * MIN_MS), lt: dayEnd },
    },
    select: { id: true, scheduledAt: true, durationMinutes: true, status: true },
    orderBy: { scheduledAt: 'asc' },
  });

  const availableSlots = DEMO_SLOT_TIMES
    .map((time) => {
      const start = istToUtc(date, time);
      return { time, start, end: new Date(start.getTime() + durationMinutes * MIN_MS) };
    })
    .filter(({ start, end }) =>
      start.getTime() > now.getTime() &&
      !existing.some((a) => overlaps(
        start.getTime(), end.getTime(),
        a.scheduledAt.getTime(), a.scheduledAt.getTime() + a.durationMinutes * MIN_MS,
      )),
    )
    .map(({ time, start }) => ({ time, iso: start.toISOString(), formatted: `${time} IST`, available: true }));

  const bookedAppointments = existing.filter((a) => a.scheduledAt >= dayStart);

  res.json({
    date,
    timezone: 'Asia/Kolkata',
    bookedCount: bookedAppointments.length,
    availableSlots,
    bookedAppointments,
  });
}));

// POST /api/v1/appointments — AI tool: book_demo()
router.post('/', asyncHandler(async (req: Request, res: Response) => {
  const parsed = CreateAppointmentSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() }); return; }

  const { leadId, durationMinutes } = parsed.data;
  const start = new Date(parsed.data.scheduledAt);
  if (start.getTime() <= Date.now()) { res.status(400).json({ error: 'scheduledAt must be in the future' }); return; }
  const end = new Date(start.getTime() + durationMinutes * MIN_MS);

  try {
    const appointment = await prisma.$transaction(async (tx) => {
      // Serialise bookings so two concurrent requests cannot both pass the overlap check.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('appointments_calendar'))`;

      const lead = await tx.lead.findUnique({ where: { id: leadId }, select: { id: true, status: true } });
      if (!lead) throw new NotFoundError('Lead not found');
      if (lead.status === 'converted') throw new ConflictError('Lead is already converted to a student');

      const nearby = await tx.appointment.findMany({
        where: {
          status: { not: 'cancelled' },
          scheduledAt: { gte: new Date(start.getTime() - 4 * 60 * MIN_MS), lt: end },
        },
        select: { scheduledAt: true, durationMinutes: true },
      });
      const clash = nearby.some((a) => overlaps(
        start.getTime(), end.getTime(),
        a.scheduledAt.getTime(), a.scheduledAt.getTime() + a.durationMinutes * MIN_MS,
      ));
      if (clash) throw new ConflictError('Requested slot overlaps an existing appointment');

      const created = await tx.appointment.create({
        data: { leadId, scheduledAt: start, durationMinutes },
        include: { lead: { include: { parent: true } } },
      });
      await tx.lead.update({ where: { id: leadId }, data: { status: 'demo_scheduled' } });
      return created;
    });
    res.status(201).json(appointment);
  } catch (err) {
    if (err instanceof NotFoundError) { res.status(404).json({ error: err.message }); return; }
    if (err instanceof ConflictError) { res.status(409).json({ error: err.message }); return; }
    throw err;
  }
}));

// PATCH /api/v1/appointments/:id/status
router.patch('/:id/status', asyncHandler(async (req: Request, res: Response) => {
  const params = IdParam.safeParse(req.params);
  const body = StatusSchema.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({
      error: 'Validation failed',
      details: { params: params.success ? undefined : params.error.flatten(), body: body.success ? undefined : body.error.flatten() },
    });
    return;
  }
  const { id } = params.data;
  const { status } = body.data;

  try {
    const appointment = await prisma.$transaction(async (tx) => {
      const current = await tx.appointment.findUnique({ where: { id }, include: { lead: { select: { id: true, status: true } } } });
      if (!current) throw new NotFoundError('Appointment not found');

      const updated = await tx.appointment.update({ where: { id }, data: { status } });

      // Cancelling the demo returns the lead to follow-up unless another demo is still active.
      if (status === 'cancelled' && current.lead.status === 'demo_scheduled') {
        const otherActive = await tx.appointment.count({
          where: { leadId: current.leadId, id: { not: id }, status: 'scheduled' },
        });
        if (otherActive === 0) {
          await tx.lead.update({ where: { id: current.leadId }, data: { status: 'follow_up' } });
        }
      }
      return updated;
    });
    res.json(appointment);
  } catch (err) {
    if (err instanceof NotFoundError) { res.status(404).json({ error: err.message }); return; }
    throw err;
  }
}));

export default router;
