// ABOUTME: Unit tests for email normalisation (lowercase + NFC + trim) and shape validation.
// ABOUTME: These are pure-function tests; no DB or server required.
import { describe, it, expect } from 'vitest';
import { normaliseEmail, isLikelyEmail } from '@/lib/email';

describe('normaliseEmail', () => {
  it('lowercases and trims', () => {
    expect(normaliseEmail('  Foo@Bar.COM ')).toBe('foo@bar.com');
  });
  it('NFC-normalises unicode', () => {
    const decomposed = 'cafe\u0301@example.com';
    const composed = 'caf\u00e9@example.com';
    expect(normaliseEmail(decomposed)).toBe(composed);
  });
});

describe('isLikelyEmail', () => {
  it.each([
    ['a@b.co', true],
    ['a.b+c@d.co.uk', true],
    ['no-at-sign', false],
    ['a@', false],
    ['@b.co', false],
    ['a@b', false],
    ['', false],
    ['a b@c.co', false],
  ])('isLikelyEmail(%p) === %p', (input, expected) => {
    expect(isLikelyEmail(input)).toBe(expected);
  });
});
