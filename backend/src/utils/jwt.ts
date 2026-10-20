import jwt from 'jsonwebtoken';
import { UserRole } from '@prisma/client';

export interface JwtPayload {
  userId: string;
  email: string;
  role: UserRole;
  parentId?: string;
  studentId?: string;
}

/**
 * Issued after a correct password but before the OTP is verified. Deliberately shaped so it can
 * never be mistaken for (or misused as) a full JwtPayload: authenticate() rejects anything with `typ`.
 */
export interface OtpPendingPayload {
  typ: 'otp_pending';
  userId: string;
  /** ties this token to one specific LoginOtp row, so a stale token can't be reused after a resend */
  otpId: string;
}

function loadSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('JWT_SECRET must be set to a random string of at least 32 characters');
  }
  return secret;
}
const SECRET: string = loadSecret();
const EXPIRES_IN = process.env.JWT_EXPIRES_IN ?? '7d';
const OTP_PENDING_EXPIRES_IN = '10m';

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, SECRET, { expiresIn: EXPIRES_IN } as jwt.SignOptions);
}

export function verifyToken(token: string): JwtPayload {
  const payload = jwt.verify(token, SECRET) as JwtPayload | OtpPendingPayload;
  if ('typ' in payload) throw new Error('Not a full session token');
  return payload;
}

export function signOtpPendingToken(payload: Omit<OtpPendingPayload, 'typ'>): string {
  return jwt.sign({ ...payload, typ: 'otp_pending' }, SECRET, { expiresIn: OTP_PENDING_EXPIRES_IN });
}

export function verifyOtpPendingToken(token: string): OtpPendingPayload {
  const payload = jwt.verify(token, SECRET) as JwtPayload | OtpPendingPayload;
  if (!('typ' in payload) || payload.typ !== 'otp_pending') throw new Error('Not an OTP-pending token');
  return payload;
}
