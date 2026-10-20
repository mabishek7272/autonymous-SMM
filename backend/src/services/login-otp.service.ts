import crypto from 'crypto';
import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { notifyUser, delivered } from './notify.service';

/**
 * Email one-time codes for the second step of login. A correct password gets you an OtpPendingPayload
 * token (jwt.ts); this service issues, emails and verifies the 6-digit code that token is redeemed for.
 *
 * Dev/test accounts: emails listed in DEV_OTP_BYPASS_EMAILS always get the fixed code DEV_OTP_CODE
 * (default 654321) and are never actually emailed, so local/CI logins don't depend on a mailbox.
 * The list is empty unless explicitly set — production accounts always get a real emailed code.
 */

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
function devCode(): string {
  return process.env.DEV_OTP_CODE?.trim() || '654321';
}

function devBypassEmails(): Set<string> {
  return new Set(
    (process.env.DEV_OTP_BYPASS_EMAILS || '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isDevBypassEmail(email: string): boolean {
  return devBypassEmails().has(email.trim().toLowerCase());
}

function generateCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function hashCode(code: string): string {
  return crypto.createHash('sha256').update(code).digest('hex');
}

export interface IssuedOtp {
  otpId: string;
  /** Only set for a dev-bypass account, so the caller can skip the "check your email" messaging. */
  devCode?: string;
}

/** Creates a fresh OTP row and emails the code (unless this is a dev-bypass account). */
export async function issueLoginOtp(user: { id: string; fullName: string; email: string }): Promise<IssuedOtp> {
  const bypass = isDevBypassEmail(user.email);
  const code = bypass ? devCode() : generateCode();
  const row = await prisma.loginOtp.create({
    data: { userId: user.id, codeHash: hashCode(code), expiresAt: new Date(Date.now() + CODE_TTL_MS) },
  });

  if (bypass) {
    logger.info('Login OTP: dev-bypass account, fixed code used, no email sent', { userId: user.id });
    return { otpId: row.id, devCode: code };
  }

  const r = await notifyUser({
    user: { id: user.id, email: user.email, phone: null },
    agentId: 'login-otp',
    targetId: row.id,
    email: {
      kind: 'security',
      subject: `Your E-Kalavya sign-in code: ${code}`,
      title: 'Your sign-in code',
      paragraphs: [
        `Hello ${user.fullName}, use this code to finish signing in to E-Kalavya. It expires in 10 minutes.`,
        'If you did not try to sign in, you can ignore this email — your password has not been shared.',
      ],
      details: [['Code', code]],
      footnote: 'Never share this code with anyone, including someone claiming to be E-Kalavya staff.',
    },
    idempotencyKey: `login-otp-${row.id}`,
  });
  if (!delivered(r)) logger.error('Login OTP: could not email the code', { userId: user.id, otpId: row.id });
  return { otpId: row.id };
}

export type VerifyOtpResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'expired' | 'already_used' | 'too_many_attempts' | 'wrong_code' };

/** Verifies a submitted code against the row, consuming it on success and counting failed attempts. */
export async function verifyLoginOtp(otpId: string, userId: string, code: string): Promise<VerifyOtpResult> {
  const row = await prisma.loginOtp.findUnique({ where: { id: otpId } });
  if (!row || row.userId !== userId) return { ok: false, reason: 'not_found' };
  if (row.consumedAt) return { ok: false, reason: 'already_used' };
  if (row.expiresAt.getTime() < Date.now()) return { ok: false, reason: 'expired' };
  if (row.attempts >= MAX_ATTEMPTS) return { ok: false, reason: 'too_many_attempts' };

  if (hashCode(code.trim()) !== row.codeHash) {
    await prisma.loginOtp.update({ where: { id: otpId }, data: { attempts: { increment: 1 } } });
    return { ok: false, reason: 'wrong_code' };
  }
  await prisma.loginOtp.update({ where: { id: otpId }, data: { consumedAt: new Date() } });
  return { ok: true };
}

/** Marks a pending OTP row unusable, e.g. when a fresh one is about to be issued for the same login. */
export async function invalidateOtp(otpId: string): Promise<void> {
  await prisma.loginOtp.updateMany({ where: { id: otpId, consumedAt: null }, data: { consumedAt: new Date() } });
}

/** Housekeeping: deletes OTP rows more than a day old. Safe to call from a cron or on demand; never required for correctness. */
export async function pruneExpiredOtps(): Promise<number> {
  const r = await prisma.loginOtp.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 24 * 3600 * 1000) } } });
  return r.count;
}
