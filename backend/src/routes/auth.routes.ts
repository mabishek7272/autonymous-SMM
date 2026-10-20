import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { login, verifyOtp, resendOtp, getMe, changePassword } from '../controllers/auth.controller';
import { authenticate } from '../middleware/auth.middleware';

const router = Router();

// vitest sets VITEST=true for every test run; skipping here avoids one shared in-memory limiter
// accumulating hits across unrelated test files that all exercise the real login endpoint.
const skipInTests = () => process.env.VITEST === 'true';

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTests,
  message: { error: 'Too many login attempts, try again later' },
});

// Separate, tighter limit for OTP verification so a brute-force guesser against one pending
// login can't be masked by the generous per-IP login limit above.
const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTests,
  message: { error: 'Too many attempts, try again later' },
});

/** POST /api/v1/auth/login — step 1: email + password. Emails a 6-digit code; returns an otpToken (no session yet). */
router.post('/login', loginLimiter, login);

/** POST /api/v1/auth/verify-otp — step 2: redeem the emailed code for a JWT + the caller's permissions */
router.post('/verify-otp', otpLimiter, verifyOtp);

/** POST /api/v1/auth/resend-otp — issue a fresh code for the same pending login */
router.post('/resend-otp', loginLimiter, resendOtp);

/** GET /api/v1/auth/me — Current user profile + permissions (account creation lives in /users) */
router.get('/me', authenticate, getMe);

/** POST /api/v1/auth/change-password — change your own password */
router.post('/change-password', authenticate, loginLimiter, changePassword);

export default router;
