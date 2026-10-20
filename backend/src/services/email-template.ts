/** Branded HTML + plain-text bodies for every outgoing email. Inline styles only (email clients ignore <style>). */

export interface EmailLayout {
  title: string;
  /** Paragraphs of plain text; blank-line-free. Newlines inside a paragraph become line breaks. */
  paragraphs: string[];
  /** Key/value rows shown in a box, e.g. Class, Time, Link. */
  details?: [string, string][];
  button?: { label: string; url: string };
  /** Small grey print under the content. */
  footnote?: string;
}

export interface RenderedEmail {
  html: string;
  text: string;
}

const BRAND = '#7C3AED';

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Only http(s) URLs may become a button/link. */
export function safeUrl(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

const para = (p: string) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#0F172A;">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`;

export function renderEmail(l: EmailLayout): RenderedEmail {
  const url = l.button ? safeUrl(l.button.url) : null;
  const details = (l.details ?? []).filter(([, v]) => v);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(l.title)}</title></head>
<body style="margin:0;padding:0;background:#F5F3FF;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F3FF;padding:24px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border-radius:14px;overflow:hidden;border:1px solid #E2E8F0;">
<tr><td style="background:${BRAND};padding:18px 24px;"><span style="font-size:18px;font-weight:700;color:#FFFFFF;letter-spacing:-0.01em;">E-Kalavya</span></td></tr>
<tr><td style="padding:28px 24px 8px;">
<h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;color:#0F172A;">${escapeHtml(l.title)}</h1>
${l.paragraphs.map(para).join('\n')}
${details.length ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 18px;background:#FAFAFC;border:1px solid #E2E8F0;border-radius:10px;">${details
    .map(([k, v]) => `<tr><td style="padding:9px 14px;font-size:12px;color:#64748B;width:34%;vertical-align:top;">${escapeHtml(k)}</td><td style="padding:9px 14px;font-size:14px;color:#0F172A;word-break:break-word;">${escapeHtml(v)}</td></tr>`)
    .join('')}</table>` : ''}
${l.button && url ? `<p style="margin:6px 0 22px;"><a href="${escapeHtml(url)}" style="display:inline-block;background:${BRAND};color:#FFFFFF;text-decoration:none;font-weight:600;font-size:15px;padding:12px 22px;border-radius:10px;">${escapeHtml(l.button.label)}</a></p>` : ''}
</td></tr>
<tr><td style="padding:14px 24px 24px;border-top:1px solid #F1F5F9;font-size:12px;line-height:1.5;color:#94A3B8;">${l.footnote ? `${escapeHtml(l.footnote)}<br>` : ''}Sent by E-Kalavya. If you did not expect this message you can ignore it.</td></tr>
</table></td></tr></table></body></html>`;

  const lines = [l.title, '', ...l.paragraphs.flatMap((p) => [p, ''])];
  if (details.length) lines.push(...details.map(([k, v]) => `${k}: ${v}`), '');
  if (l.button && url) lines.push(`${l.button.label}: ${url}`, '');
  if (l.footnote) lines.push(l.footnote, '');
  lines.push('— E-Kalavya');
  return { html, text: lines.join('\n') };
}
