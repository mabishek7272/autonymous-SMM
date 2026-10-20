import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../utils/database';
import { signToken, signOtpPendingToken, verifyOtpPendingToken } from '../utils/jwt';
import { logger } from '../utils/logger';
import { z } from 'zod';
import { ROLE_PERMISSIONS } from '../utils/permissions';
import { sendPasswordChangedEmail } from '../services/account-email.service';
import { issueLoginOtp, verifyLoginOtp, invalidateOtp, isDevBypassEmail } from '../services/login-otp.service';

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().optional(),
});

/**
 * Step 1 of login: email (+ password, for staff roles). On success this never returns a session
 * token directly — it emails a 6-digit code and returns an otpToken that /auth/verify-otp redeems
 * for the real one.
 *
 * Parent/student accounts are passwordless: they never had a usable password to begin with (see
 * student.routes.ts onboard-lead), so the password check is skipped entirely for those roles and
 * any login proceeds straight to OTP. Every other role still requires a correct password.
 */
export async function login(req: Request, res: Response): Promise<void> {
  const parsed = LoginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }

  const { email, password } = parsed.data;

  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.isActive) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    // Known, accepted tradeoff: for a parent/student email this returns 200 (issuing an OTP) while an
    // unknown or staff email returns 401 with no side effect, which is a mild account-enumeration /
    // OTP-inbox-spam oracle. Bounded by loginLimiter (20/15min/IP) and the OTP itself is useless to an
    // attacker without access to the victim's inbox. Don't "fix" this into a uniform response without
    // re-checking that tradeoff first.
    const isPasswordless = user.role === 'parent' || user.role === 'student';
    if (!isPasswordless) {
      if (!password) {
        res.status(401).json({ error: 'Invalid credentials' });
        return;
      }
      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) {
        res.status(401).json({ error: 'Invalid credentials' });
        return;
      }
    }

    const issued = await issueLoginOtp(user);
    const otpToken = signOtpPendingToken({ userId: user.id, otpId: issued.otpId });
    res.json({
      otpRequired: true,
      otpToken,
      expiresInSeconds: 600,
      // Dev/test accounts (DEV_OTP_BYPASS_EMAILS) skip real email; tell the UI so it can say so.
      devBypass: isDevBypassEmail(user.email),
      maskedEmail: maskEmail(user.email),
    });
  } catch (error) {
    logger.error('Login error', { error });
    res.status(500).json({ error: 'Login failed' });
  }
}

function maskEmail(email: string): string {
  const [name, domain] = email.split('@');
  if (!domain) return email;
  const visible = name.slice(0, Math.min(2, name.length));
  return `${visible}${'*'.repeat(Math.max(1, name.length - visible.length))}@${domain}`;
}

const VerifyOtpSchema = z.object({
  otpToken: z.string().min(1),
  code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code'),
});

const OTP_FAILURE_MESSAGE: Record<string, string> = {
  not_found: 'This sign-in code is no longer valid. Please sign in again.',
  expired: 'This code has expired. Please sign in again to get a new one.',
  already_used: 'This code has already been used. Please sign in again.',
  too_many_attempts: 'Too many incorrect attempts. Please sign in again to get a new code.',
  wrong_code: 'That code is incorrect.',
};

/** Step 2 of login: redeem the emailed code for a real session token. */
export async function verifyOtp(req: Request, res: Response): Promise<void> {
  const parsed = VerifyOtpSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }

  let pending;
  try {
    pending = verifyOtpPendingToken(parsed.data.otpToken);
  } catch {
    res.status(401).json({ error: 'This sign-in session has expired. Please sign in again.' });
    return;
  }

  try {
    const result = await verifyLoginOtp(pending.otpId, pending.userId, parsed.data.code);
    if (!result.ok) {
      res.status(400).json({ error: OTP_FAILURE_MESSAGE[result.reason], reason: result.reason });
      return;
    }

    const user = await prisma.user.findUnique({ where: { id: pending.userId } });
    if (!user || !user.isActive) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const token = signToken({
      userId: user.id,
      email: user.email,
      role: user.role,
      ...(user.parentId ? { parentId: user.parentId } : {}),
      ...(user.studentId ? { studentId: user.studentId } : {}),
    });
    res.json({
      token,
      user: {
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        role: user.role,
        permissions: ROLE_PERMISSIONS[user.role],
      },
    });
  } catch (error) {
    logger.error('Verify OTP error', { error });
    res.status(500).json({ error: 'Could not verify the code' });
  }
}

const ResendOtpSchema = z.object({ otpToken: z.string().min(1) });

/** Invalidates the previous code and issues a fresh one for the same pending login. */
export async function resendOtp(req: Request, res: Response): Promise<void> {
  const parsed = ResendOtpSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }
  let pending;
  try {
    pending = verifyOtpPendingToken(parsed.data.otpToken);
  } catch {
    res.status(401).json({ error: 'This sign-in session has expired. Please sign in again.' });
    return;
  }
  try {
    const user = await prisma.user.findUnique({ where: { id: pending.userId } });
    if (!user || !user.isActive) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }
    await invalidateOtp(pending.otpId);
    const issued = await issueLoginOtp(user);
    const otpToken = signOtpPendingToken({ userId: user.id, otpId: issued.otpId });
    res.json({ otpRequired: true, otpToken, expiresInSeconds: 600, devBypass: isDevBypassEmail(user.email), maskedEmail: maskEmail(user.email) });
  } catch (error) {
    logger.error('Resend OTP error', { error });
    res.status(500).json({ error: 'Could not resend the code' });
  }
}

const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(128),
});

/** POST /auth/change-password — any signed-in user changes their own password (needs the current one). */
export async function changePassword(req: Request, res: Response): Promise<void> {
  const parsed = ChangePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
    return;
  }
  const { currentPassword, newPassword } = parsed.data;
  if (currentPassword === newPassword) {
    res.status(400).json({ error: 'Choose a password different from the current one', details: { fieldErrors: { newPassword: ['Must differ from the current password'] } } });
    return;
  }
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user!.userId } });
    if (!user || !user.isActive || !(await bcrypt.compare(currentPassword, user.passwordHash))) {
      res.status(400).json({ error: 'Current password is incorrect', details: { fieldErrors: { currentPassword: ['Incorrect password'] } } });
      return;
    }
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash(newPassword, 12) } });
    await sendPasswordChangedEmail(user);
    res.status(204).end();
  } catch (error) {
    logger.error('Change password error', { error });
    res.status(500).json({ error: 'Failed to change password' });
  }
}

export async function getMe(req: Request, res: Response): Promise<void> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: { id: true, fullName: true, email: true, role: true, phone: true, isActive: true, createdAt: true, parentId: true, studentId: true },
    });
    if (!user || !user.isActive) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.json({ ...user, permissions: ROLE_PERMISSIONS[user.role] });
  } catch (error) {
    logger.error('GetMe error', { error });
    res.status(500).json({ error: 'Failed to fetch user' });
  }
}
