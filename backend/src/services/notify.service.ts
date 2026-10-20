import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { enqueueWhatsApp } from '../utils/queues';
import { enqueueEmail } from '../utils/email-queue';
import { isEmailEnabled, isValidEmail, type EmailKind } from './email.service';
import { renderEmail, type EmailLayout } from './email-template';

/**
 * Every message to a parent or staff member goes out on BOTH channels: WhatsApp and email.
 * Channels are independent: one failing never blocks the other, each gets its own Message row
 * (parents) so the dashboard shows what was sent where, and an opted-out parent receives neither.
 */

export interface EmailSpec extends EmailLayout {
  kind: EmailKind;
  subject: string;
}

export type ChannelOutcome = 'queued' | 'no_address' | 'disabled' | 'opted_out' | 'not_requested' | 'failed';

export interface NotifyResult {
  whatsapp: ChannelOutcome;
  email: ChannelOutcome;
}

export interface ParentTarget {
  id: string;
  whatsappNumber: string;
  email: string | null;
  optedOut: boolean;
}

interface BaseOptions {
  agentId: string;
  targetId?: string;
  /** WhatsApp text; omit to skip the WhatsApp channel */
  whatsapp?: string | null;
  /** Email content; omit to skip the email channel */
  email?: EmailSpec | null;
  /** Makes the email safe to retry/replay without double-sending (Resend idempotency key) */
  idempotencyKey?: string;
}

async function queueEmail(
  to: string,
  spec: EmailSpec,
  base: BaseOptions,
  record: { parentId?: string; studentId?: string; leadId?: string } | null,
): Promise<ChannelOutcome> {
  const { html, text } = renderEmail(spec);
  let messageId: string | undefined;
  if (record) {
    const row = await prisma.message
      .create({
        data: { ...record, direction: 'outbound', channel: 'email', subject: spec.subject.slice(0, 255), body: text.slice(0, 20000), status: 'queued', agentId: base.agentId },
      })
      .catch((err: Error) => {
        logger.error('Notify: failed to record email Message row', { error: err.message });
        return null;
      });
    messageId = row?.id;
  }
  try {
    await enqueueEmail({
      to: to.trim(),
      kind: spec.kind,
      subject: spec.subject,
      html,
      text,
      agentId: base.agentId,
      targetId: base.targetId,
      messageId,
      idempotencyKey: base.idempotencyKey,
    });
    return 'queued';
  } catch (err) {
    if (messageId) await prisma.message.update({ where: { id: messageId }, data: { status: 'failed:enqueue' } }).catch(() => undefined);
    logger.error('Notify: failed to queue email', { error: (err as Error).message });
    return 'failed';
  }
}

async function queueWhatsApp(
  to: string,
  text: string,
  base: BaseOptions,
  record: { parentId?: string; studentId?: string; leadId?: string } | null,
): Promise<ChannelOutcome> {
  let messageId: string | undefined;
  if (record) {
    const row = await prisma.message
      .create({ data: { ...record, direction: 'outbound', channel: 'whatsapp', body: text, status: 'queued', agentId: base.agentId } })
      .catch((err: Error) => {
        logger.error('Notify: failed to record WhatsApp Message row', { error: err.message });
        return null;
      });
    messageId = row?.id;
  }
  try {
    await enqueueWhatsApp({ to, text, agentId: base.agentId, targetId: base.targetId, ...(messageId ? { messageId } : {}) });
    return 'queued';
  } catch (err) {
    if (messageId) await prisma.message.update({ where: { id: messageId }, data: { status: 'failed:enqueue' } }).catch(() => undefined);
    logger.error('Notify: failed to queue WhatsApp message', { error: (err as Error).message });
    return 'failed';
  }
}

export interface NotifyParentOptions extends BaseOptions {
  parent: ParentTarget;
  studentId?: string;
  leadId?: string;
}

/** WhatsApp + email to a parent. */
export async function notifyParent(o: NotifyParentOptions): Promise<NotifyResult> {
  if (o.parent.optedOut) return { whatsapp: 'opted_out', email: 'opted_out' };
  const record = { parentId: o.parent.id, studentId: o.studentId, leadId: o.leadId };

  const whatsapp: ChannelOutcome = o.whatsapp ? await queueWhatsApp(o.parent.whatsappNumber, o.whatsapp, o, record) : 'not_requested';

  let email: ChannelOutcome = 'not_requested';
  if (o.email) {
    if (!isEmailEnabled()) email = 'disabled';
    else if (!isValidEmail(o.parent.email)) email = 'no_address';
    else email = await queueEmail(o.parent.email, o.email, o, record);
  }
  return { whatsapp, email };
}

export interface UserTarget {
  id: string;
  email: string;
  phone: string | null;
}

export interface NotifyUserOptions extends BaseOptions {
  user: UserTarget;
}

/** WhatsApp + email to a staff member (teacher, superadmin). Staff messages are not stored as parent Messages. */
export async function notifyUser(o: NotifyUserOptions): Promise<NotifyResult> {
  const whatsapp: ChannelOutcome = o.whatsapp ? (o.user.phone ? await queueWhatsApp(o.user.phone, o.whatsapp, o, null) : 'no_address') : 'not_requested';
  let email: ChannelOutcome = 'not_requested';
  if (o.email) {
    if (!isEmailEnabled()) email = 'disabled';
    else if (!isValidEmail(o.user.email)) email = 'no_address';
    else email = await queueEmail(o.user.email, o.email, o, null);
  }
  return { whatsapp, email };
}

/** True when at least one channel accepted the message. */
export const delivered = (r: NotifyResult): boolean => r.whatsapp === 'queued' || r.email === 'queued';
