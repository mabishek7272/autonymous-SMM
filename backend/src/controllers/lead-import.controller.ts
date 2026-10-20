import { Request, Response } from 'express';
import { z } from 'zod';
import { LeadStatus } from '@prisma/client';
import { prisma } from '../utils/database';
import { normalizePhone } from '../utils/phone';
import { aiActivityLogService } from '../services/ai-activity-log.service';
import { inferLeadStatus, mapTimeline, splitPhones } from '../services/import.service';

const Row = z.object({
  name: z.string().trim().min(1).max(255),
  grade: z.string().trim().max(50).optional(),
  board: z.string().trim().max(50).optional(),
  phone: z.union([z.string(), z.number()]),
  timeline: z.string().optional(),
  /** "Notes / Subject needed" column */
  notes: z.string().max(2000).optional(),
  /** "Location / Alt contact / Remarks" column */
  remarks: z.string().max(2000).optional(),
});
const ImportSchema = z.object({ rows: z.array(Row).min(1).max(500), dryRun: z.boolean().optional() });

const norm = (s: string | undefined) => (s ?? '').trim().toLowerCase();

/**
 * POST /api/v1/leads/import — bulk-load the counsellors' enquiry sheet.
 * - Parent is matched by WhatsApp number (created when new). A second row for the same number and the same
 *   class+board is skipped as a duplicate; the same number with a different class becomes another lead.
 * - Stage is inferred conservatively from the notes ("Enrolled" -> admission, "Not interested" -> lost, "Demo" -> demo booked...).
 * - dryRun:true returns the same counts and per-row problems without writing anything.
 */
export async function importLeads(req: Request, res: Response): Promise<void> {
  const parsed = ImportSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }
  const dryRun = parsed.data.dryRun === true;
  const invalid: { row: number; message: string }[] = [];
  const stats = { created: 0, skippedDuplicates: 0, newParents: 0, byStatus: {} as Record<string, number> };

  const prepared = parsed.data.rows.map((r, i) => {
    const phones = splitPhones(r.phone).map((p) => normalizePhone(p)).filter((p): p is string => !!p);
    return { r, row: i + 1, phone: phones[0] ?? null, extraPhones: phones.slice(1) };
  });

  const existingParents = new Map(
    (await prisma.parent.findMany({
      where: { whatsappNumber: { in: prepared.map((p) => p.phone).filter((p): p is string => !!p) } },
      select: { id: true, whatsappNumber: true, leads: { select: { gradeInterested: true, boardInterested: true } } },
    })).map((p) => [p.whatsappNumber, p]),
  );
  const seenInBatch = new Set<string>();

  for (const p of prepared) {
    if (!p.phone) {
      invalid.push({ row: p.row, message: `"${p.r.name}": no valid phone number (${String(p.r.phone) || 'empty'})` });
      continue;
    }
    const key = `${p.phone}|${norm(p.r.grade)}|${norm(p.r.board)}`;
    const dupInDb = existingParents.get(p.phone)?.leads.some((l) => norm(l.gradeInterested ?? undefined) === norm(p.r.grade) && norm(l.boardInterested ?? undefined) === norm(p.r.board));
    if (seenInBatch.has(key) || dupInDb) {
      stats.skippedDuplicates++;
      continue;
    }
    seenInBatch.add(key);

    const status: LeadStatus = inferLeadStatus(p.r.notes, p.r.remarks);
    stats.byStatus[status] = (stats.byStatus[status] ?? 0) + 1;
    stats.created++;
    if (!existingParents.has(p.phone)) {
      stats.newParents++;
      existingParents.set(p.phone, { id: '', whatsappNumber: p.phone, leads: [] }); // later rows with this number reuse the parent
    }
    if (dryRun) continue;

    const parent = await prisma.parent.upsert({
      where: { whatsappNumber: p.phone },
      update: {},
      create: { fullName: p.r.name, whatsappNumber: p.phone },
    });
    const notes = [p.r.remarks, p.extraPhones.length ? `Alt: ${p.extraPhones.join(', ')}` : null].filter(Boolean).join(' · ');
    await prisma.lead.create({
      data: {
        parentId: parent.id,
        status,
        gradeInterested: p.r.grade || null,
        boardInterested: p.r.board || null,
        requirements: p.r.notes || null,
        notes: notes || null,
        timeline: mapTimeline(p.r.timeline),
      },
    });
  }

  if (!dryRun && stats.created > 0) {
    await aiActivityLogService.log({
      agentId: 'human',
      targetId: req.user?.userId,
      actionType: 'leads_imported',
      payload: { created: stats.created, skippedDuplicates: stats.skippedDuplicates, invalid: invalid.length, by: req.user?.userId },
      status: 'success',
    });
  }
  res.status(dryRun ? 200 : 201).json({ dryRun, ...stats, invalid });
}
