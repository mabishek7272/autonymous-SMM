import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../utils/database';
import { normalizePhone } from '../utils/phone';
import { aiActivityLogService } from './ai-activity-log.service';
import { sendAccountCreatedEmail } from './account-email.service';

/** Bulk creation of teacher accounts and student records (used by the import screens and the single-student form). */

/** A row together with its 1-based position in the pasted/uploaded file, so problems point at the right line. */
export interface NumberedRow<T> {
  row: number;
  r: T;
}

export interface RowProblem {
  row: number;
  message: string;
}

/** "XII Chem; XII Math" -> ["XII Chem", "XII Math"] (semicolon or new line; blanks and duplicates dropped). */
export function splitBatchNames(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[;\n]/)) {
    const name = part.trim();
    if (name && !seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      out.push(name);
    }
  }
  return out;
}

/** YYYY-MM-DD, DD/MM/YYYY or DD-MM-YYYY -> Date (UTC midnight), or null when unreadable / impossible. */
export function parseFlexibleDate(raw: string | undefined | null): Date | null {
  if (!raw) return null;
  const s = raw.trim();
  let y: number, m: number, d: number;
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (match) [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else if ((match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s))) [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? date : null;
}

export function generatePassword(): string {
  return crypto.randomBytes(9).toString('base64url');
}

async function resolveBatches(names: string[]): Promise<{ found: Map<string, { id: string; batchName: string; teacherId: string | null }>; unknown: string[] }> {
  const all = names.length
    ? await prisma.batch.findMany({ where: { batchName: { in: names, mode: 'insensitive' } }, select: { id: true, batchName: true, teacherId: true } })
    : [];
  const found = new Map<string, { id: string; batchName: string; teacherId: string | null }>();
  for (const b of all) if (b.batchName) found.set(b.batchName.toLowerCase(), { id: b.id, batchName: b.batchName, teacherId: b.teacherId });
  return { found, unknown: names.filter((n) => !found.has(n.toLowerCase())) };
}

// ── Teachers ─────────────────────────────────────────────────

export const TeacherRow = z.object({
  fullName: z.string().trim().min(2).max(255),
  email: z.string().trim().toLowerCase().email().max(255),
  phone: z.string().trim().min(1),
  initials: z.string().trim().max(10).optional(),
  /** Batches this teacher teaches, separated by ';' */
  batches: z.string().max(2000).optional(),
  /** Optional; a random one is generated (and returned once) when omitted */
  password: z.string().min(8).max(128).optional(),
});
export type TeacherRowInput = z.infer<typeof TeacherRow>;

export interface TeacherImportResult {
  dryRun: boolean;
  created: number;
  existing: number;
  batchesAssigned: number;
  invalid: RowProblem[];
  warnings: RowProblem[];
  /** Only for newly created accounts whose password was generated; shown once, never stored in plain text. */
  credentials: { email: string; fullName: string; password: string }[];
  /** How many new teachers were sent their login details by email */
  emailed: number;
}

export async function importTeachers(items: NumberedRow<TeacherRowInput>[], opts: { dryRun: boolean; actorId: string }): Promise<TeacherImportResult> {
  const invalid: RowProblem[] = [];
  const warnings: RowProblem[] = [];
  const credentials: TeacherImportResult['credentials'] = [];
  let created = 0;
  let existing = 0;
  let batchesAssigned = 0;
  let emailed = 0;
  const createdAccounts: { id: string; fullName: string; email: string; password: string | null }[] = [];

  const rows = items.map((x) => x.r);
  const emails = [...new Set(rows.map((r) => r.email))];
  const existingUsers = new Map((await prisma.user.findMany({ where: { email: { in: emails, mode: 'insensitive' } } })).map((u) => [u.email.toLowerCase(), u]));
  const allBatchNames = [...new Set(rows.flatMap((r) => splitBatchNames(r.batches)))];
  const { found, unknown } = await resolveBatches(allBatchNames);
  const unknownSet = new Set(unknown.map((n) => n.toLowerCase()));

  type Plan = { row: number; r: TeacherRowInput; phone: string; user: (typeof existingUsers extends Map<string, infer U> ? U : never) | undefined; batchIds: string[] };
  const plans: Plan[] = [];
  const seenEmail = new Set<string>();
  const claimedBatch = new Map<string, string>(); // batch id -> email within this import

  items.forEach(({ row, r }) => {
    const phone = normalizePhone(r.phone);
    if (!phone) return void invalid.push({ row, message: `${r.fullName}: phone number "${r.phone}" is not valid` });
    if (seenEmail.has(r.email)) return void invalid.push({ row, message: `${r.email} appears more than once in this file` });
    seenEmail.add(r.email);
    const user = existingUsers.get(r.email);
    if (user && user.role !== 'teacher') return void invalid.push({ row, message: `${r.email} already belongs to a ${user.role} account` });

    const names = splitBatchNames(r.batches);
    const bad = names.filter((n) => unknownSet.has(n.toLowerCase()));
    if (bad.length) return void invalid.push({ row, message: `${r.fullName}: unknown batch(es) ${bad.map((b) => `"${b}"`).join(', ')}. Import the timetable first or fix the name` });

    const batchIds: string[] = [];
    for (const n of names) {
      const b = found.get(n.toLowerCase())!;
      const other = claimedBatch.get(b.id);
      if (other && other !== r.email) {
        warnings.push({ row, message: `${b.batchName} is listed for ${other} as well; it was kept with the first` });
        continue;
      }
      if (b.teacherId && b.teacherId !== user?.id) {
        warnings.push({ row, message: `${b.batchName} already has a teacher assigned; left unchanged` });
        continue;
      }
      claimedBatch.set(b.id, r.email);
      batchIds.push(b.id);
    }
    plans.push({ row, r, phone, user, batchIds });
  });

  for (const p of plans) {
    if (p.user) existing++;
    else created++;
    batchesAssigned += p.batchIds.filter((id) => [...found.values()].find((b) => b.id === id)?.teacherId !== p.user?.id).length;
  }

  if (!opts.dryRun && plans.length) {
    const prepared = await Promise.all(
      plans.map(async (p) => {
        if (p.user) return { p, hash: null as string | null, password: null as string | null };
        const password = p.r.password ?? generatePassword();
        return { p, hash: await bcrypt.hash(password, 12), password: p.r.password ? null : password };
      }),
    );
    await prisma.$transaction(async (tx) => {
      for (const { p, hash, password } of prepared) {
        let userId = p.user?.id;
        if (!userId) {
          const u = await tx.user.create({
            data: { fullName: p.r.fullName, email: p.r.email, passwordHash: hash!, role: 'teacher', phone: p.phone, initials: p.r.initials?.toUpperCase() || null },
          });
          userId = u.id;
          if (password) credentials.push({ email: u.email, fullName: u.fullName, password });
          createdAccounts.push({ id: u.id, fullName: u.fullName, email: u.email, password });
        } else {
          // Existing teacher: fill in missing details, never overwrite what is already there
          await tx.user.update({
            where: { id: userId },
            data: { phone: p.user!.phone ?? p.phone, initials: p.user!.initials ?? (p.r.initials?.toUpperCase() || null) },
          });
        }
        if (p.batchIds.length) await tx.batch.updateMany({ where: { id: { in: p.batchIds } }, data: { teacherId: userId } });
      }
    });
    await aiActivityLogService.log({
      agentId: 'human',
      targetId: opts.actorId,
      actionType: 'teachers_imported',
      payload: { created, existing, batchesAssigned, by: opts.actorId },
      status: 'success',
    });
    // After the commit: email each new teacher their login (generated passwords are included; chosen ones are not)
    for (const a of createdAccounts) {
      if (await sendAccountCreatedEmail(a, { temporaryPassword: a.password ?? undefined, role: 'Teacher' })) emailed++;
    }
  }

  return { dryRun: opts.dryRun, created, existing, batchesAssigned, invalid, warnings, credentials, emailed };
}

// ── Students ─────────────────────────────────────────────────

export const StudentRow = z.object({
  studentName: z.string().trim().min(2).max(255),
  parentName: z.string().trim().max(255).optional(),
  parentPhone: z.string().trim().min(1),
  parentEmail: z.string().trim().email().max(255).optional(),
  grade: z.string().trim().max(20).optional(),
  board: z.string().trim().max(40).optional(),
  dateOfBirth: z.string().optional(),
  admissionDate: z.string().optional(),
  /** Batches (class + subject) the student is registered for, separated by ';' */
  batches: z.string().max(2000).optional(),
});
export type StudentRowInput = z.infer<typeof StudentRow>;

export interface StudentImportResult {
  dryRun: boolean;
  created: number;
  existing: number;
  newParents: number;
  enrollmentsAdded: number;
  invalid: RowProblem[];
  warnings: RowProblem[];
  studentIds: string[];
}

export async function importStudents(items: NumberedRow<StudentRowInput>[], opts: { dryRun: boolean; actorId: string }): Promise<StudentImportResult> {
  const invalid: RowProblem[] = [];
  const warnings: RowProblem[] = [];
  const studentIds: string[] = [];
  let created = 0;
  let existing = 0;
  let newParents = 0;
  let enrollmentsAdded = 0;

  const rows = items.map((x) => x.r);
  const prepared = items.map(({ r, row }) => ({ r, row, phone: normalizePhone(r.parentPhone) }));
  const parents = new Map(
    (await prisma.parent.findMany({
      where: { whatsappNumber: { in: prepared.map((p) => p.phone).filter((x): x is string => !!x) } },
      include: { students: { include: { enrollments: { select: { batchId: true } } } } },
    })).map((p) => [p.whatsappNumber, p]),
  );
  const { found, unknown } = await resolveBatches([...new Set(rows.flatMap((r) => splitBatchNames(r.batches)))]);
  const unknownSet = new Set(unknown.map((n) => n.toLowerCase()));
  const seen = new Set<string>();
  const parentSeenInFile = new Set<string>();

  type Plan = { row: number; r: StudentRowInput; phone: string; dob: Date | null; admission: Date | null; batchIds: string[] };
  const plans: Plan[] = [];

  for (const { r, row, phone } of prepared) {
    if (!phone) { invalid.push({ row, message: `${r.studentName}: parent phone "${r.parentPhone}" is not valid` }); continue; }
    const key = `${phone}|${r.studentName.toLowerCase()}`;
    if (seen.has(key)) { invalid.push({ row, message: `${r.studentName} (${phone}) appears more than once in this file` }); continue; }
    seen.add(key);
    const parent = parents.get(phone);
    if (!parent && !(r.parentName && r.parentName.length >= 2)) {
      invalid.push({ row, message: `${r.studentName}: parent name is required for a new parent number ${phone}` });
      continue;
    }
    const dob = r.dateOfBirth ? parseFlexibleDate(r.dateOfBirth) : null;
    if (r.dateOfBirth && !dob) { invalid.push({ row, message: `${r.studentName}: date of birth "${r.dateOfBirth}" is not a valid date (use DD/MM/YYYY)` }); continue; }
    const admission = r.admissionDate ? parseFlexibleDate(r.admissionDate) : null;
    if (r.admissionDate && !admission) { invalid.push({ row, message: `${r.studentName}: admission date "${r.admissionDate}" is not a valid date (use DD/MM/YYYY)` }); continue; }
    const names = splitBatchNames(r.batches);
    const bad = names.filter((n) => unknownSet.has(n.toLowerCase()));
    if (bad.length) { invalid.push({ row, message: `${r.studentName}: unknown batch(es) ${bad.map((b) => `"${b}"`).join(', ')}. Import the timetable first or fix the name` }); continue; }

    const batchIds = names.map((n) => found.get(n.toLowerCase())!.id);
    const prior = parent?.students.find((s) => s.fullName.toLowerCase() === r.studentName.toLowerCase());
    if (prior) {
      existing++;
      const have = new Set(prior.enrollments.map((e) => e.batchId));
      const add = batchIds.filter((b) => !have.has(b));
      enrollmentsAdded += add.length;
      if (add.length === 0 && batchIds.length === 0) warnings.push({ row, message: `${r.studentName} already exists; nothing to add` });
    } else {
      created++;
      enrollmentsAdded += batchIds.length;
    }
    if (!parent && !parentSeenInFile.has(phone)) { newParents++; parentSeenInFile.add(phone); }
    plans.push({ row, r, phone, dob, admission, batchIds });
  }

  if (!opts.dryRun && plans.length) {
    await prisma.$transaction(async (tx) => {
      for (const p of plans) {
        // Look the parent up first: an existing parent needs no name in the row, and upsert would still validate its create payload
        let parent = await tx.parent.findUnique({ where: { whatsappNumber: p.phone } });
        if (!parent) {
          parent = await tx.parent.create({ data: { fullName: p.r.parentName!, whatsappNumber: p.phone, email: p.r.parentEmail ?? null } });
        } else if (p.r.parentEmail && !parent.email) {
          parent = await tx.parent.update({ where: { id: parent.id }, data: { email: p.r.parentEmail } });
        }
        let student = await tx.student.findFirst({ where: { parentId: parent.id, fullName: { equals: p.r.studentName, mode: 'insensitive' } } });
        if (!student) {
          student = await tx.student.create({
            data: {
              parentId: parent.id,
              fullName: p.r.studentName,
              dateOfBirth: p.dob ?? undefined,
              admissionDate: p.admission ?? new Date(),
              grade: p.r.grade || null,
              board: p.r.board || null,
            },
          });
        } else {
          // Existing student: fill gaps only
          await tx.student.update({
            where: { id: student.id },
            data: {
              grade: student.grade ?? (p.r.grade || null),
              board: student.board ?? (p.r.board || null),
              dateOfBirth: student.dateOfBirth ?? p.dob ?? undefined,
            },
          });
        }
        studentIds.push(student.id);
        for (const batchId of p.batchIds) {
          await tx.enrollment.upsert({
            where: { studentId_batchId: { studentId: student.id, batchId } },
            update: {},
            create: { studentId: student.id, batchId },
          });
        }
      }
    });
    await aiActivityLogService.log({
      agentId: 'human',
      targetId: opts.actorId,
      actionType: 'students_imported',
      payload: { created, existing, newParents, enrollmentsAdded, by: opts.actorId },
      status: 'success',
    });
  }

  return { dryRun: opts.dryRun, created, existing, newParents, enrollmentsAdded, invalid, warnings, studentIds };
}

/** Validates raw rows one by one; unreadable rows become per-row problems instead of failing the whole request. */
export function validateRows<S extends z.ZodTypeAny>(schema: S, raw: unknown[]): { items: NumberedRow<z.infer<S>>[]; invalid: RowProblem[] } {
  const items: NumberedRow<z.infer<S>>[] = [];
  const invalid: RowProblem[] = [];
  raw.forEach((value, i) => {
    const parsed = schema.safeParse(value);
    if (parsed.success) items.push({ row: i + 1, r: parsed.data });
    else invalid.push({ row: i + 1, message: parsed.error.issues.map((x) => `${x.path.join('.') || 'row'}: ${x.message}`).join('; ') });
  });
  return { items, invalid };
}
