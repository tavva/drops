import { describe, it, expect } from 'vitest';
import { isValidSlug, suggestSlug, RESERVED_USERNAMES } from '@/lib/slug';

describe('isValidSlug', () => {
  it.each([
    ['a', false],
    ['ab', true],
    ['a-b', true],
    ['a--b', false],   // consecutive hyphens banned — would collide with <user>--<drop> host delimiter
    ['a---b', false],
    ['-a', false],
    ['a-', false],
    ['a-b-c', true],
    ['a-b--c', false],
    ['AB', false],
    ['a_b', false],
    ['a.b', false],
    ['a'.repeat(32), true],
    ['a'.repeat(33), false],
    ['0a', true],
    ['a0', true],
  ])('isValidSlug(%p) === %p', (input, expected) => {
    expect(isValidSlug(input)).toBe(expected);
  });
});

describe('suggestSlug', () => {
  it('slugifies an email local-part', () => {
    expect(suggestSlug('Ben.Phillips+tag@example.com')).toBe('ben-phillips-tag');
  });
  it('falls back to "user" for empty result', () => {
    expect(suggestSlug('+@example.com')).toBe('user');
  });
});

describe('RESERVED_USERNAMES', () => {
  it('includes the canonical list', () => {
    for (const r of ['app', 'auth', 'api', 'static', 'admin', '_next', 'health', 'favicon.ico', 'robots.txt']) {
      expect(RESERVED_USERNAMES).toContain(r);
    }
  });
});
