import { logger } from '../utils/logger';
import { notifyUser, delivered } from './notify.service';

/** Account emails come from security@e-kalavya.com. Passwords are only ever emailed, never sent over WhatsApp. */

const appUrl = () => (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');

/** "Your E-Kalavya account is ready", optionally with the generated temporary password. Returns true when queued. */
export async function sendAccountCreatedEmail(
  user: { id: string; fullName: string; email: string },
  opts: { temporaryPassword?: string; role?: string } = {},
): Promise<boolean> {
  try {
    const r = await notifyUser({
      user: { id: user.id, email: user.email, phone: null },
      agentId: 'account-service',
      targetId: user.id,
      email: {
        kind: 'security',
        subject: 'Your E-Kalavya account is ready',
        title: `Welcome to E-Kalavya, ${user.fullName}`,
        paragraphs: [
          'An account has been created for you on the E-Kalavya dashboard.',
          opts.temporaryPassword
            ? 'Sign in with the email address and temporary password below, then change the password straight away using the key icon at the top right.'
            : 'Your administrator will share your password with you separately. You can change it after signing in using the key icon at the top right.',
        ],
        details: [
          ['Sign-in email', user.email],
          ...(opts.temporaryPassword ? ([['Temporary password', opts.temporaryPassword]] as [string, string][]) : []),
          ...(opts.role ? ([['Role', opts.role]] as [string, string][]) : []),
        ],
        button: { label: 'Sign in', url: `${appUrl()}/login` },
        footnote: 'For your security, do not forward this email.',
      },
      idempotencyKey: `account-created-${user.id}`,
    });
    return delivered(r);
  } catch (err) {
    logger.error('Failed to queue account-created email', { userId: user.id, error: (err as Error).message });
    return false;
  }
}

/** Security notice after a password change, so an unexpected change is noticed. */
export async function sendPasswordChangedEmail(user: { id: string; fullName: string; email: string }): Promise<void> {
  try {
    await notifyUser({
      user: { id: user.id, email: user.email, phone: null },
      agentId: 'account-service',
      targetId: user.id,
      email: {
        kind: 'security',
        subject: 'Your E-Kalavya password was changed',
        title: 'Your password was changed',
        paragraphs: [
          `Hello ${user.fullName}, the password for your E-Kalavya account was just changed.`,
          'If this was you, no action is needed. If it was not, contact your administrator immediately at security@e-kalavya.com.',
        ],
        details: [['Account', user.email], ['When', new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST']],
      },
      idempotencyKey: `password-changed-${user.id}-${Date.now()}`,
    });
  } catch (err) {
    logger.error('Failed to queue password-changed email', { userId: user.id, error: (err as Error).message });
  }
}
