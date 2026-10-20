import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UnrecoverableError } from 'bullmq';

const send = vi.hoisted(() => vi.fn());
vi.mock('resend', () => ({ Resend: class { emails = { send }; } }));

import { fromAddress, replyToAddress, isEmailEnabled, isValidEmail, sendViaResend } from './email.service';
import { renderEmail, escapeHtml, safeUrl } from './email-template';

const saved = { ...process.env };
beforeEach(() => {
  vi.clearAllMocks();
  process.env.RESEND_API_KEY = 're_test_key';
  delete process.env.EMAIL_ENABLED;
  delete process.env.EMAIL_DOMAIN;
  for (const k of ['GENERAL', 'SECURITY', 'REPORTS', 'SYSTEM']) delete process.env[`EMAIL_FROM_${k}`];
});
afterEach(() => { process.env = { ...saved }; });

const mail = { to: 'parent@example.com', kind: 'general' as const, subject: 'Hi', html: '<p>Hi</p>', text: 'Hi' };

describe('sender identities', () => {
  it('uses the four e-kalavya.com addresses', () => {
    expect(fromAddress('general')).toBe('E-Kalavya <hello@e-kalavya.com>');
    expect(fromAddress('security')).toBe('E-Kalavya Security <security@e-kalavya.com>');
    expect(fromAddress('reports')).toBe('E-Kalavya Reports <reports@e-kalavya.com>');
    expect(fromAddress('system')).toBe('E-Kalavya <no-reply@e-kalavya.com>');
  });

  it('honours a domain or full-address override, and has no reply-to for no-reply', () => {
    process.env.EMAIL_DOMAIN = 'mail.example.org';
    expect(fromAddress('reports')).toBe('E-Kalavya Reports <reports@mail.example.org>');
    process.env.EMAIL_FROM_SECURITY = 'Sec <s@x.org>';
    expect(fromAddress('security')).toBe('Sec <s@x.org>');
    expect(replyToAddress('system')).toBeUndefined();
    expect(replyToAddress('general')).toBe('ekalavyavirtualclasses@gmail.com');
    process.env.EMAIL_REPLY_TO = 'custom@example.org';
    expect(replyToAddress('reports')).toBe('custom@example.org');
    delete process.env.EMAIL_REPLY_TO;
  });
});

describe('enablement and validation', () => {
  it('is off without a key or when switched off', () => {
    expect(isEmailEnabled()).toBe(true);
    process.env.EMAIL_ENABLED = 'false';
    expect(isEmailEnabled()).toBe(false);
    delete process.env.EMAIL_ENABLED;
    process.env.RESEND_API_KEY = '  ';
    expect(isEmailEnabled()).toBe(false);
  });

  it('validates addresses', () => {
    expect(isValidEmail('a@b.co')).toBe(true);
    expect(isValidEmail('no-at-sign')).toBe(false);
    expect(isValidEmail('a b@c.d')).toBe(false);
    expect(isValidEmail(null)).toBe(false);
  });
});

describe('sendViaResend', () => {
  it('sends with the right sender, reply-to and idempotency key', async () => {
    send.mockResolvedValue({ data: { id: 'em_1' }, error: null });
    await expect(sendViaResend({ ...mail, kind: 'reports', idempotencyKey: 'k1' })).resolves.toEqual({ id: 'em_1' });
    expect(send).toHaveBeenCalledWith(
      { from: 'E-Kalavya Reports <reports@e-kalavya.com>', to: ['parent@example.com'], subject: 'Hi', html: '<p>Hi</p>', text: 'Hi', replyTo: 'ekalavyavirtualclasses@gmail.com' },
      { idempotencyKey: 'k1' },
    );
  });

  it('refuses to send when email is not configured, without calling Resend', async () => {
    process.env.RESEND_API_KEY = '';
    await expect(sendViaResend(mail)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(send).not.toHaveBeenCalled();
  });

  it('retries rate limits and server errors, but not rejected addresses', async () => {
    send.mockResolvedValueOnce({ data: null, error: { name: 'rate_limit_exceeded', message: 'slow down', statusCode: 429 } });
    const rate = await sendViaResend(mail).catch((e) => e);
    expect(rate).toBeInstanceOf(Error);
    expect(rate).not.toBeInstanceOf(UnrecoverableError);

    send.mockResolvedValueOnce({ data: null, error: { name: 'application_error', message: 'oops', statusCode: 500 } });
    expect(await sendViaResend(mail).catch((e) => e)).not.toBeInstanceOf(UnrecoverableError);

    send.mockResolvedValueOnce({ data: null, error: { name: 'validation_error', message: 'invalid to', statusCode: 422 } });
    expect(await sendViaResend(mail).catch((e) => e)).toBeInstanceOf(UnrecoverableError);
  });
});

describe('email template', () => {
  it('escapes user text and only links http(s) URLs', () => {
    expect(escapeHtml(`<b>"x" & 'y'</b>`)).toBe('&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;');
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl('https://teams.microsoft.com/meet/1')).toBe('https://teams.microsoft.com/meet/1');
    const r = renderEmail({
      title: 'Class <today>',
      paragraphs: ['Line one\nLine two'],
      details: [['Class', 'XII <Chem>'], ['Empty', '']],
      button: { label: 'Join', url: 'javascript:alert(1)' },
    });
    expect(r.html).toContain('Class &lt;today&gt;');
    expect(r.html).toContain('Line one<br>Line two');
    expect(r.html).toContain('XII &lt;Chem&gt;');
    expect(r.html).not.toContain('javascript:');
    expect(r.html).not.toContain('Empty');
    expect(r.text).toContain('Class: XII <Chem>');
  });

  it('renders a button with its link in both html and text', () => {
    const r = renderEmail({ title: 'T', paragraphs: ['P'], button: { label: 'Join the class', url: 'https://meet.google.com/abc-defg-hij' } });
    expect(r.html).toContain('href="https://meet.google.com/abc-defg-hij"');
    expect(r.text).toContain('Join the class: https://meet.google.com/abc-defg-hij');
  });
});
