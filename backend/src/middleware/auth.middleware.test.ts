import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Request, Response } from 'express';
import { UserRole } from '@prisma/client';
import { authenticate } from './auth.middleware';
import { signToken } from '../utils/jwt';

function mockRes() {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

describe('authenticate', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('returns 401 when no Authorization header is present, even outside production', () => {
    process.env.NODE_ENV = 'development';
    const req = { headers: {} } as Request;
    const res = mockRes();
    const next = vi.fn();

    authenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
    expect(req.user).toBeUndefined();
  });

  it('returns 401 for an invalid token, even outside production', () => {
    process.env.NODE_ENV = 'development';
    const req = { headers: { authorization: 'Bearer not-a-real-token' } } as Request;
    const res = mockRes();
    const next = vi.fn();

    authenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('attaches the decoded user and calls next for a valid token', () => {
    process.env.NODE_ENV = 'production';
    const token = signToken({ userId: 'u1', email: 'superadmin@ekalavya.in', role: UserRole.superadmin });
    const req = { headers: { authorization: `Bearer ${token}` } } as Request;
    const res = mockRes();
    const next = vi.fn();

    authenticate(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    // toMatchObject (not toEqual): jwt.verify adds standard `iat`/`exp` claims
    // to the decoded payload, which are irrelevant to this middleware's logic.
    expect(req.user).toMatchObject({ userId: 'u1', email: 'superadmin@ekalavya.in', role: UserRole.superadmin });
  });

  it('rejects an OTP-pending token (it must never work as a session token)', async () => {
    const { signOtpPendingToken } = await import('../utils/jwt');
    const token = signOtpPendingToken({ userId: 'u1', otpId: 'otp1' });
    const req = { headers: { authorization: `Bearer ${token}` } } as Request;
    const res = mockRes();
    const next = vi.fn();

    authenticate(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});
