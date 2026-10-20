import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { prisma } from '../utils/database';
import { asyncHandler } from '../utils/async-handler';
import { rolesWith } from '../utils/permissions';
import { courseNameFromBatch, linkNameFromUrl, minutesBetween, parseDay, parseTime } from '../services/import.service';

const router = Router();
router.use(authenticate, authorize(...rolesWith('classlinks:manage')));

const httpsUrl = z.string().trim().url().max(2000).refine((u) => {
  try { return new URL(u).protocol === 'https:'; } catch { return false; }
}, { message: 'Must be an https link' });

const LinkFields = {
  name: z.string().trim().min(2).max(120),
  meetingUrl: httpsUrl,
  grade: z.string().trim().max(20).nullable().optional(),
  board: z.string().trim().max(40).nullable().optional(),
  subject: z.string().trim().max(80).nullable().optional(),
};
const CreateSchema = z.object(LinkFields);
const UpdateSchema = z.object({ ...LinkFields, isActive: z.boolean() }).partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });
const BulkSchema = z.object({ links: z.array(CreateSchema).min(1).max(200) });

const withUsage = { _count: { select: { batches: true } } } as const;

// GET /api/v1/class-links
router.get('/', asyncHandler(async (_req: Request, res: Response) => {
  const links = await prisma.classLink.findMany({ include: withUsage, orderBy: [{ grade: 'asc' }, { name: 'asc' }] });
  res.json({ data: links });
}));

// POST /api/v1/class-links
router.post('/', asyncHandler(async (req: Request, res: Response) => {
  const parsed = CreateSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
  try {
    res.status(201).json(await prisma.classLink.create({ data: parsed.data, include: withUsage }));
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return void res.status(409).json({ error: `A class link named "${parsed.data.name}" already exists` });
    }
    throw err;
  }
}));

// POST /api/v1/class-links/bulk — import many links at once; existing names are updated, nothing is deleted
router.post('/bulk', asyncHandler(async (req: Request, res: Response) => {
  const parsed = BulkSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
  const seen = new Set<string>();
  for (const l of parsed.data.links) {
    const key = l.name.toLowerCase();
    if (seen.has(key)) return void res.status(400).json({ error: `Duplicate name in import: "${l.name}"` });
    seen.add(key);
  }
  let created = 0;
  let updated = 0;
  await prisma.$transaction(async (tx) => {
    for (const l of parsed.data.links) {
      const existing = await tx.classLink.findUnique({ where: { name: l.name }, select: { id: true } });
      if (existing) {
        await tx.classLink.update({ where: { id: existing.id }, data: { ...l, isActive: true } });
        updated++;
      } else {
        await tx.classLink.create({ data: l });
        created++;
      }
    }
  });
  res.status(201).json({ created, updated, total: parsed.data.links.length });
}));

// PATCH /api/v1/class-links/:id
router.patch('/:id', asyncHandler(async (req: Request, res: Response) => {
  const parsed = UpdateSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
  const id = String(req.params.id);
  if (!(await prisma.classLink.findUnique({ where: { id }, select: { id: true } }))) {
    return void res.status(404).json({ error: 'Class link not found' });
  }
  try {
    res.json(await prisma.classLink.update({ where: { id }, data: parsed.data, include: withUsage }));
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return void res.status(409).json({ error: 'Another class link already uses that name' });
    }
    throw err;
  }
}));

// DELETE /api/v1/class-links/:id — only when no batch uses it (deactivate otherwise)
router.delete('/:id', asyncHandler(async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const link = await prisma.classLink.findUnique({ where: { id }, include: withUsage });
  if (!link) return void res.status(404).json({ error: 'Class link not found' });
  if (link._count.batches > 0) {
    return void res.status(409).json({ error: `Used by ${link._count.batches} batch(es). Unassign it first or deactivate it instead.` });
  }
  await prisma.classLink.delete({ where: { id } });
  res.status(204).end();
}));

// ── Timetable import ──────────────────────────────────────────

const TimetableRow = z.object({
  batchName: z.string().trim().min(1).max(100),
  day: z.union([z.string(), z.number()]),
  startTime: z.string(),
  endTime: z.string().optional(),
  durationMinutes: z.number().int().min(5).max(480).optional(),
  meetingUrl: httpsUrl,
});
const TimetableSchema = z.object({
  rows: z.array(TimetableRow).min(1).max(500),
  dryRun: z.boolean().optional(),
});

/**
 * POST /api/v1/class-links/timetable-import
 * Creates/updates batches, their class links and their weekly timetable from one pasted timetable.
 * - A batch is identified by its name (case-insensitive); courses are derived from the name ("XII Chem" -> "Class XII").
 * - A meeting URL that is not in the library yet is added to it. A URL can be shared by many batches.
 * - The most-used link of a batch becomes its standing link; slots that use a different room keep their own link.
 * - The listed slots REPLACE the weekly timetable of each batch in the import (other batches are untouched).
 * All rows are validated first; one bad row rejects the whole import and nothing is written.
 */
router.post('/timetable-import', asyncHandler(async (req: Request, res: Response) => {
  const parsed = TimetableSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });

  const errors: { row: number; message: string }[] = [];
  type Slot = { batchName: string; dayOfWeek: number; startTime: string; durationMinutes: number; meetingUrl: string };
  const slots: Slot[] = [];
  const seenSlot = new Set<string>();
  parsed.data.rows.forEach((r, i) => {
    const row = i + 1;
    const dayOfWeek = parseDay(r.day);
    const startTime = parseTime(r.startTime);
    if (dayOfWeek === null) return void errors.push({ row, message: `Unknown day "${r.day}"` });
    if (!startTime) return void errors.push({ row, message: `Cannot read start time "${r.startTime}"` });
    let durationMinutes = r.durationMinutes ?? 60;
    if (r.endTime) {
      const end = parseTime(r.endTime);
      if (!end) return void errors.push({ row, message: `Cannot read end time "${r.endTime}"` });
      durationMinutes = minutesBetween(startTime, end);
      if (durationMinutes < 5 || durationMinutes > 480) return void errors.push({ row, message: 'End time must be after the start time (max 8 hours)' });
    }
    const key = `${r.batchName.toLowerCase()}|${dayOfWeek}|${startTime}`;
    if (seenSlot.has(key)) return void errors.push({ row, message: `Duplicate slot for "${r.batchName}" on the same day and time` });
    seenSlot.add(key);
    slots.push({ batchName: r.batchName, dayOfWeek, startTime, durationMinutes, meetingUrl: r.meetingUrl });
  });
  if (errors.length) return void res.status(400).json({ error: `${errors.length} row(s) need fixing`, errors });

  const byBatch = new Map<string, Slot[]>();
  for (const sl of slots) {
    const k = sl.batchName.toLowerCase();
    byBatch.set(k, [...(byBatch.get(k) ?? []), sl]);
  }
  const urls = [...new Set(slots.map((s) => s.meetingUrl))];

  const existingLinks = await prisma.classLink.findMany({ where: { meetingUrl: { in: urls } } });
  const existingBatches = await prisma.batch.findMany({
    where: { batchName: { in: [...byBatch.values()].map((v) => v[0].batchName), mode: 'insensitive' } },
    select: { id: true, batchName: true },
  });
  const summary = {
    batches: byBatch.size,
    batchesToCreate: [...byBatch.values()].filter((v) => !existingBatches.some((b) => b.batchName?.toLowerCase() === v[0].batchName.toLowerCase())).length,
    links: urls.length,
    linksToCreate: urls.filter((u) => !existingLinks.some((l) => l.meetingUrl === u)).length,
    slots: slots.length,
  };
  if (parsed.data.dryRun) return void res.json({ dryRun: true, ...summary });

  await prisma.$transaction(async (tx) => {
    // 1) library entries
    const linkByUrl = new Map(existingLinks.map((l) => [l.meetingUrl, l.id]));
    const usedNames = new Set((await tx.classLink.findMany({ select: { name: true } })).map((l) => l.name.toLowerCase()));
    for (const url of urls) {
      if (linkByUrl.has(url)) continue;
      const base = linkNameFromUrl(url).slice(0, 110);
      let name = base;
      for (let n = 2; usedNames.has(name.toLowerCase()); n++) name = `${base} (${n})`;
      usedNames.add(name.toLowerCase());
      linkByUrl.set(url, (await tx.classLink.create({ data: { name, meetingUrl: url } })).id);
    }
    // 2) batches + timetable
    for (const [, list] of byBatch) {
      const batchName = list[0].batchName;
      let batch = await tx.batch.findFirst({ where: { batchName: { equals: batchName, mode: 'insensitive' } } });
      if (!batch) {
        const courseName = courseNameFromBatch(batchName);
        const course = (await tx.course.findFirst({ where: { courseName } })) ?? (await tx.course.create({ data: { courseName } }));
        batch = await tx.batch.create({ data: { courseId: course.id, batchName } });
      }
      const counts = new Map<string, number>();
      for (const sl of list) counts.set(sl.meetingUrl, (counts.get(sl.meetingUrl) ?? 0) + 1);
      const defaultUrl = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
      await tx.batch.update({ where: { id: batch.id }, data: { classLinkId: linkByUrl.get(defaultUrl)! } });
      await tx.batchSchedule.deleteMany({ where: { batchId: batch.id } });
      await tx.batchSchedule.createMany({
        data: list.map((sl) => ({
          batchId: batch!.id,
          dayOfWeek: sl.dayOfWeek,
          startTime: sl.startTime,
          durationMinutes: sl.durationMinutes,
          classLinkId: sl.meetingUrl === defaultUrl ? null : linkByUrl.get(sl.meetingUrl)!,
        })),
      });
    }
  });
  res.status(201).json({ dryRun: false, ...summary });
}));

export default router;
