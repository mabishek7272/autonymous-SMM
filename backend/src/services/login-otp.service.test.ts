import { describe, it, expect, vi, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { prisma } from '../utils/database';

const q = vi.hoisted(() => ({ em: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../utils/email-queue', () => ({ enqueueEmail: q.em }));
vi.mock('../utils/queues', () => ({ enqueueWhatsApp: vi.fn().mockResolvedValue(undefined) }));

import { issueLoginOtp, verifyLoginOtp, invalidateOtp, isDevBypassEmail } from './login-otp.service';

const sfx = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
let userId = '';
const savedEnv = { ...process.env };

beforeAll(async () => {
  const u = await prisma.user.create({ data: { fullName: `Otp ${sfx}`, email: `otp-${sfx}@test.local`, passwordHash: 'x', role: 'teacher' } });
  userId = u.id;
});
afterAll(async () => {
  await prisma.loginOtp.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});
beforeEach(() => { vi.clearAllMocks(); process.env.RESEND_API_KEY = 're_test'; });
afterEach(() => { process.env = { ...savedEnv }; });

describe('isDevBypassEmail', () => {
  it('matches case-insensitively against the configured list', () => {
    process.env.DEV_OTP_BYPASS_EMAILS = 'Dev@Example.com, other@x.io';
    expect(isDevBypassEmail('dev@example.com')).toBe(true);
    expect(isDevBypassEmail('OTHER@X.IO')).toBe(true);
    expect(isDevBypassEmail('real@parent.com')).toBe(false);
  });

  it('is empty (nothing bypasses) when unset', () => {
    delete process.env.DEV_OTP_BYPASS_EMAILS;
    expect(isDevBypassEmail('anyone@example.com')).toBe(false);
  });
});

describe('issueLoginOtp / verifyLoginOtp', () => {
  it('emails a real code for a normal account and verifies it once', async () => {
    const issued = await issueLoginOtp({ id: userId, fullName: 'Otp User', email: `otp-${sfx}@test.local` });
    expect(issued.devCode).toBeUndefined();
    expect(q.em).toHaveBeenCalledTimes(1);
    const job = q.em.mock.calls[0][0];
    expect(job.kind).toBe('security');
    const code = job.subject.match(/(\d{6})$/)![1];

    expect(await verifyLoginOtp(issued.otpId, userId, 'wrong1')).toEqual({ ok: false, reason: 'wrong_code' });
    expect(await verifyLoginOtp(issued.otpId, userId, code)).toEqual({ ok: true });
    // A consumed code cannot be reused
    expect(await verifyLoginOtp(issued.otpId, userId, code)).toEqual({ ok: false, reason: 'already_used' });
  });

  it('uses the fixed dev code and sends no email for a bypass account', async () => {
    process.env.DEV_OTP_BYPASS_EMAILS = `otp-${sfx}@test.local`;
    process.env.DEV_OTP_CODE = '111222';
    const issued = await issueLoginOtp({ id: userId, fullName: 'Otp User', email: `otp-${sfx}@test.local` });
    expect(issued.devCode).toBe('111222');
    expect(q.em).not.toHaveBeenCalled();
    expect(await verifyLoginOtp(issued.otpId, userId, '111222')).toEqual({ ok: true });
  });

  it('locks out after 5 wrong attempts', async () => {
    const issued = await issueLoginOtp({ id: userId, fullName: 'Otp User', email: `otp-${sfx}@test.local` });
    for (let i = 0; i < 5; i++) expect((await verifyLoginOtp(issued.otpId, userId, '000000')).ok).toBe(false);
    const result = await verifyLoginOtp(issued.otpId, userId, '000000');
    expect(result).toEqual({ ok: false, reason: 'too_many_attempts' });
  });

  it('rejects a code for the wrong user and an unknown otp id', async () => {
    const issued = await issueLoginOtp({ id: userId, fullName: 'Otp User', email: `otp-${sfx}@test.local` });
    expect(await verifyLoginOtp(issued.otpId, 'someone-else', '000000')).toEqual({ ok: false, reason: 'not_found' });
    expect(await verifyLoginOtp('00000000-0000-0000-0000-000000000000', userId, '000000')).toEqual({ ok: false, reason: 'not_found' });
  });

  it('treats an expired row as expired, not wrong_code', async () => {
    const issued = await issueLoginOtp({ id: userId, fullName: 'Otp User', email: `otp-${sfx}@test.local` });
    await prisma.loginOtp.update({ where: { id: issued.otpId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await verifyLoginOtp(issued.otpId, userId, '000000')).toEqual({ ok: false, reason: 'expired' });
  });

  it('invalidateOtp consumes a row without affecting an already-consumed one', async () => {
    const issued = await issueLoginOtp({ id: userId, fullName: 'Otp User', email: `otp-${sfx}@test.local` });
    await invalidateOtp(issued.otpId);
    expect(await verifyLoginOtp(issued.otpId, userId, '000000')).toEqual({ ok: false, reason: 'already_used' });
  });
});
