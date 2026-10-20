import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma } from '../utils/database';

const q = vi.hoisted(() => ({ em: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../utils/email-queue', () => ({ enqueueEmail: q.em }));
vi.mock('../utils/queues', () => ({ enqueueWhatsApp: vi.fn().mockResolvedValue(undefined) }));

const sfx = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
let app: any;
const ids: Record<string, string> = {};
const savedEnv = { ...process.env };
const PASSWORD = 'Real#Password1';

beforeAll(async () => {
  app = (await import('../app')).default;
  const real = await prisma.user.create({ data: { fullName: `Real ${sfx}`, email: `real-${sfx}@test.local`, passwordHash: await bcrypt.hash(PASSWORD, 4), role: 'teacher' } });
  const dev = await prisma.user.create({ data: { fullName: `Dev ${sfx}`, email: `dev-${sfx}@test.local`, passwordHash: await bcrypt.hash(PASSWORD, 4), role: 'teacher' } });
  const inactive = await prisma.user.create({ data: { fullName: `Off ${sfx}`, email: `off-${sfx}@test.local`, passwordHash: await bcrypt.hash(PASSWORD, 4), role: 'teacher', isActive: false } });
  Object.assign(ids, { real: real.id, dev: dev.id, inactive: inactive.id });
});
afterAll(async () => {
  process.env = { ...savedEnv };
  await prisma.loginOtp.deleteMany({ where: { userId: { in: Object.values(ids) } } });
  await prisma.user.deleteMany({ where: { id: { in: Object.values(ids) } } });
  await prisma.$disconnect();
});
beforeEach(() => {
  vi.clearAllMocks();
  process.env.RESEND_API_KEY = 're_test';
  process.env.DEV_OTP_BYPASS_EMAILS = `dev-${sfx}@test.local`;
  process.env.DEV_OTP_CODE = '654321';
});
afterEach(() => undefined);

const emailedCode = () => q.em.mock.calls[0][0].subject.match(/(\d{6})$/)![1];

describe('POST /auth/login (step 1)', () => {
  it('never returns a session token; returns an otpToken and does not reveal the real code in the response', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({ email: `real-${sfx}@test.local`, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ otpRequired: true, devBypass: false });
    expect(res.body.token).toBeUndefined();
    expect(res.body.otpToken).toEqual(expect.any(String));
    expect(res.body.maskedEmail).toMatch(/^re\*+@test\.local$/);
    expect(JSON.stringify(res.body)).not.toContain(emailedCode());
  });

  it('flags a dev-bypass account and sends no email for it', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({ email: `dev-${sfx}@test.local`, password: PASSWORD });
    expect(res.body.devBypass).toBe(true);
    expect(q.em).not.toHaveBeenCalled();
  });

  it('rejects a wrong password or an inactive account without leaking which', async () => {
    const wrongPw = await request(app).post('/api/v1/auth/login').send({ email: `real-${sfx}@test.local`, password: 'nope' });
    expect(wrongPw.status).toBe(401);
    expect(wrongPw.body.error).toBe('Invalid credentials');
    const off = await request(app).post('/api/v1/auth/login').send({ email: `off-${sfx}@test.local`, password: PASSWORD });
    expect(off.status).toBe(401);
    expect(off.body.error).toBe('Invalid credentials');
    expect(q.em).not.toHaveBeenCalled();
  });
});

describe('POST /auth/verify-otp (step 2)', () => {
  it('completes login with the real emailed code and the token then works as a session', async () => {
    const login = await request(app).post('/api/v1/auth/login').send({ email: `real-${sfx}@test.local`, password: PASSWORD });
    const code = emailedCode();
    const wrong = await request(app).post('/api/v1/auth/verify-otp').send({ otpToken: login.body.otpToken, code: '000000' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.reason).toBe('wrong_code');

    const ok = await request(app).post('/api/v1/auth/verify-otp').send({ otpToken: login.body.otpToken, code });
    expect(ok.status).toBe(200);
    expect(ok.body.user).toMatchObject({ email: `real-${sfx}@test.local`, role: 'teacher' });
    expect(ok.body.token).toEqual(expect.any(String));

    const me = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${ok.body.token}`);
    expect(me.status).toBe(200);

    // Same code cannot be redeemed twice
    const again = await request(app).post('/api/v1/auth/verify-otp').send({ otpToken: login.body.otpToken, code });
    expect(again.status).toBe(400);
    expect(again.body.reason).toBe('already_used');
  });

  it('completes login with the fixed dev code for a bypass account', async () => {
    const login = await request(app).post('/api/v1/auth/login').send({ email: `dev-${sfx}@test.local`, password: PASSWORD });
    const ok = await request(app).post('/api/v1/auth/verify-otp').send({ otpToken: login.body.otpToken, code: '654321' });
    expect(ok.status).toBe(200);
    expect(ok.body.user.email).toBe(`dev-${sfx}@test.local`);
  });

  it('rejects malformed codes, an expired/garbage otpToken, and an otp-pending token used as a bearer token', async () => {
    const login = await request(app).post('/api/v1/auth/login').send({ email: `real-${sfx}@test.local`, password: PASSWORD });
    expect((await request(app).post('/api/v1/auth/verify-otp').send({ otpToken: login.body.otpToken, code: 'abcdef' })).status).toBe(400);
    expect((await request(app).post('/api/v1/auth/verify-otp').send({ otpToken: 'garbage', code: '123456' })).status).toBe(401);
    const asBearer = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${login.body.otpToken}`);
    expect(asBearer.status).toBe(401);
  });

  it('locks out after 5 wrong attempts', async () => {
    const login = await request(app).post('/api/v1/auth/login').send({ email: `real-${sfx}@test.local`, password: PASSWORD });
    for (let i = 0; i < 5; i++) await request(app).post('/api/v1/auth/verify-otp').send({ otpToken: login.body.otpToken, code: '000000' });
    const locked = await request(app).post('/api/v1/auth/verify-otp').send({ otpToken: login.body.otpToken, code: emailedCode() });
    expect(locked.status).toBe(400);
    expect(locked.body.reason).toBe('too_many_attempts');
  });
});

describe('parentId/studentId on the session token', () => {
  let parentRecordId: string;
  let parentUserId: string;

  beforeAll(async () => {
    const parent = await prisma.parent.create({ data: { fullName: `Portal Parent ${sfx}`, whatsappNumber: `9199900${sfx.slice(0, 5)}` } });
    parentRecordId = parent.id;
    const user = await prisma.user.create({
      data: { fullName: `Portal Parent ${sfx}`, email: `portal-parent-${sfx}@test.local`, passwordHash: await bcrypt.hash(PASSWORD, 4), role: 'parent', parentId: parent.id },
    });
    parentUserId = user.id;
  });

  beforeEach(() => {
    // the outer beforeEach resets DEV_OTP_BYPASS_EMAILS; extend it so our parent account also bypasses.
    process.env.DEV_OTP_BYPASS_EMAILS = `dev-${sfx}@test.local,portal-parent-${sfx}@test.local`;
  });

  afterAll(async () => {
    await prisma.loginOtp.deleteMany({ where: { userId: parentUserId } });
    await prisma.user.delete({ where: { id: parentUserId } });
    await prisma.parent.delete({ where: { id: parentRecordId } });
  });

  it('verify-otp includes parentId in the JWT and /auth/me response for a parent-role account', async () => {
    const login = await request(app).post('/api/v1/auth/login').send({ email: `portal-parent-${sfx}@test.local`, password: PASSWORD });
    expect(login.body.devBypass).toBe(true);
    const verify = await request(app).post('/api/v1/auth/verify-otp').send({ otpToken: login.body.otpToken, code: '654321' });
    expect(verify.status).toBe(200);
    expect(verify.body.user.role).toBe('parent');
    const decoded = jwt.decode(verify.body.token) as { parentId?: string };
    expect(decoded.parentId).toBe(parentRecordId);

    const me = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${verify.body.token}`);
    expect(me.body.parentId).toBe(parentRecordId);
  });

  it('logs a parent-role account in with only an email — no password field at all', async () => {
    const login = await request(app).post('/api/v1/auth/login').send({ email: `portal-parent-${sfx}@test.local` });
    expect(login.status).toBe(200);
    expect(login.body.otpRequired).toBe(true);
    expect(login.body.devBypass).toBe(true);

    const verify = await request(app).post('/api/v1/auth/verify-otp').send({ otpToken: login.body.otpToken, code: '654321' });
    expect(verify.status).toBe(200);
    expect(verify.body.user.role).toBe('parent');
  });

  it('never makes staff login passwordless: a teacher account is rejected when password is omitted', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({ email: `real-${sfx}@test.local` });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid credentials');
    expect(res.body.otpRequired).toBeUndefined();
  });

  it('never makes staff login passwordless: a teacher account is rejected when password is an empty string', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({ email: `real-${sfx}@test.local`, password: '' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid credentials');
    expect(res.body.otpRequired).toBeUndefined();
  });
});

describe('POST /auth/resend-otp', () => {
  it('invalidates the previous code and issues a new one that works', async () => {
    const login = await request(app).post('/api/v1/auth/login').send({ email: `real-${sfx}@test.local`, password: PASSWORD });
    const firstCode = emailedCode();
    const resend = await request(app).post('/api/v1/auth/resend-otp').send({ otpToken: login.body.otpToken });
    expect(resend.status).toBe(200);
    expect(resend.body.otpToken).not.toBe(login.body.otpToken);

    // the original code no longer works, even against its own (still-valid-looking) token
    const stale = await request(app).post('/api/v1/auth/verify-otp').send({ otpToken: login.body.otpToken, code: firstCode });
    expect(stale.status).toBe(400);
    expect(stale.body.reason).toBe('already_used');

    const secondCode = q.em.mock.calls[1][0].subject.match(/(\d{6})$/)![1];
    const ok = await request(app).post('/api/v1/auth/verify-otp').send({ otpToken: resend.body.otpToken, code: secondCode });
    expect(ok.status).toBe(200);
  });
});
