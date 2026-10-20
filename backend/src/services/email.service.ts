import { Resend } from 'resend';
import { UnrecoverableError } from 'bullmq';
import { logger } from '../utils/logger';

/**
 * Outgoing email through Resend. Four sender identities on the verified e-kalavya.com domain:
 *   general  hello@     class links, reminders, admissions follow-ups, welcome mails
 *   security security@  login details, password changes
 *   reports  reports@   weekly progress reports, attendance
 *   system   no-reply@  automated briefings and alerts
 * Nothing here throws when email is not configured: callers get isEmailEnabled() === false and skip.
 */

export type EmailKind = 'general' | 'security' | 'reports' | 'system';

const LOCAL_PART: Record<EmailKind, string> = { general: 'hello', security: 'security', reports: 'reports', system: 'no-reply' };
const DISPLAY_NAME: Record<EmailKind, string> = {
  general: 'E-Kalavya',
  security: 'E-Kalavya Security',
  reports: 'E-Kalavya Reports',
  system: 'E-Kalavya',
};

const domain = () => (process.env.EMAIL_DOMAIN || 'e-kalavya.com').trim();

export function fromAddress(kind: EmailKind): string {
  const override = process.env[`EMAIL_FROM_${kind.toUpperCase()}`];
  return override?.trim() || `${DISPLAY_NAME[kind]} <${LOCAL_PART[kind]}@${domain()}>`;
}

/**
 * Replies go to a real human inbox, not the sending address, except for the no-reply identity.
 * Override with EMAIL_REPLY_TO; default is the operator's Gmail.
 */
export function replyToAddress(kind: EmailKind): string | undefined {
  if (kind === 'system') return undefined;
  return (process.env.EMAIL_REPLY_TO || 'ekalavyavirtualclasses@gmail.com').trim();
}

export function isEmailEnabled(): boolean {
  return !!process.env.RESEND_API_KEY?.trim() && process.env.EMAIL_ENABLED !== 'false';
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function isValidEmail(value: string | null | undefined): value is string {
  return !!value && value.length <= 254 && EMAIL_RE.test(value.trim());
}

let client: Resend | null = null;
let clientKey = '';
function getClient(): Resend {
  const key = process.env.RESEND_API_KEY!.trim();
  if (!client || clientKey !== key) {
    client = new Resend(key);
    clientKey = key;
  }
  return client;
}

export interface OutgoingEmail {
  to: string;
  kind: EmailKind;
  subject: string;
  html: string;
  text: string;
  idempotencyKey?: string;
}

/** Sends one email. Throws UnrecoverableError for permanent problems (bad address, not configured) so queues do not retry. */
export async function sendViaResend(mail: OutgoingEmail): Promise<{ id: string }> {
  if (!isEmailEnabled()) throw new UnrecoverableError('Email is not configured (RESEND_API_KEY is empty)');
  const { data, error } = await getClient().emails.send(
    {
      from: fromAddress(mail.kind),
      to: [mail.to],
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      ...(replyToAddress(mail.kind) ? { replyTo: replyToAddress(mail.kind)! } : {}),
    },
    mail.idempotencyKey ? { idempotencyKey: mail.idempotencyKey } : undefined,
  );
  if (error) {
    const status = (error as { statusCode?: number | null }).statusCode ?? 0;
    const message = `Resend: ${error.name}: ${error.message}`;
    // 429 and 5xx (and network errors, which have no status) are worth retrying; other 4xx are our fault or the address's
    if (status === 429 || status >= 500 || status === 0) throw new Error(message);
    logger.warn('Email rejected by Resend', { to: mail.to, status, error: error.message });
    throw new UnrecoverableError(message);
  }
  return { id: data!.id };
}
