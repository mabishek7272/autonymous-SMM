import { describe, it, expect } from 'vitest';
import { normalizePhone, isValidPhone } from './phone';

describe('normalizePhone', () => {
  it('adds 91 to 10-digit Indian mobiles', () => {
    expect(normalizePhone('9876543210')).toBe('919876543210');
    expect(normalizePhone('98765 43210')).toBe('919876543210');
    expect(normalizePhone('09876543210')).toBe('919876543210');
  });
  it('handles + / 00 / formatting', () => {
    expect(normalizePhone('+91 98765-43210')).toBe('919876543210');
    expect(normalizePhone('0091 9876543210')).toBe('919876543210');
    expect(normalizePhone('+1 (415) 555-2671')).toBe('14155552671');
  });
  it('accepts user JIDs with device suffix', () => {
    expect(normalizePhone('919876543210@s.whatsapp.net')).toBe('919876543210');
    expect(normalizePhone('919876543210:12@s.whatsapp.net')).toBe('919876543210');
  });
  it('rejects groups, lids, junk and bad lengths', () => {
    expect(normalizePhone('120363025@g.us')).toBeNull();
    expect(normalizePhone('12345@lid')).toBeNull();
    expect(normalizePhone('abc')).toBeNull();
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone('1234567')).toBeNull();
    expect(normalizePhone('5876543210')).toBeNull();
    expect(normalizePhone('91987654321')).toBeNull();
    expect(isValidPhone('9876543210')).toBe(true);
    expect(isValidPhone('nope')).toBe(false);
  });
});
