/**
 * Phone number normalisation. Every number that enters the system (webhooks,
 * lead creation, imports) should pass through normalizePhone() so Parent.whatsappNumber
 * is always digits-only E.164 without '+', e.g. '919876543210'.
 */

const DEFAULT_COUNTRY_CODE = '91';
const WHATSAPP_USER_JID = /@(s\.whatsapp\.net|c\.us)$/i;

/**
 * Returns digits-only E.164 (no '+') or null when the input cannot be a phone number.
 * - 10-digit Indian mobiles (6-9 prefix) get the default country code 91
 * - '0' trunk prefix, '+', '00' international prefix, spaces/dashes/brackets are stripped
 * - WhatsApp user JIDs ('9198...@s.whatsapp.net', optionally with ':device') are accepted
 * - group/lid/broadcast JIDs and anything with letters are rejected
 */
export function normalizePhone(raw: unknown): string | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  let s = String(raw).trim();
  if (!s) return null;

  if (s.includes('@')) {
    if (!WHATSAPP_USER_JID.test(s)) return null;
    s = s.replace(WHATSAPP_USER_JID, '').replace(/:\d+$/, '');
  }

  if (/[a-z]/i.test(s)) return null;
  if (!/^[\d\s+\-().]+$/.test(s)) return null;

  let digits = s.replace(/\D/g, '');
  if (s.trim().startsWith('+')) {
    // explicit international format, keep as is
  } else if (digits.startsWith('00')) {
    digits = digits.slice(2);
  } else if (digits.length === 11 && digits.startsWith('0')) {
    digits = digits.slice(1); // Indian trunk prefix 0XXXXXXXXXX
  }

  if (digits.length === 10) {
    if (!/^[6-9]/.test(digits)) return null;
    digits = DEFAULT_COUNTRY_CODE + digits;
  }

  if (digits.startsWith(DEFAULT_COUNTRY_CODE) && digits.length !== 12) return null;
  if (digits.startsWith(DEFAULT_COUNTRY_CODE) && !/^91[6-9]/.test(digits)) return null;
  if (digits.length < 8 || digits.length > 15) return null;
  if (digits.startsWith('0')) return null;
  return digits;
}

export function isValidPhone(raw: unknown): boolean {
  return normalizePhone(raw) !== null;
}
