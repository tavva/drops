// ABOUTME: Unit tests for the UUID v4 format guard used at route boundaries.
// ABOUTME: Strict: rejects anything that isn't a 36-char canonical UUID.
import { describe, it, expect } from 'vitest';
import { isUuid } from '@/lib/uuid';

describe('isUuid', () => {
  it('accepts canonical UUIDs', () => {
    expect(isUuid('3f2504e0-4f89-41d3-9a0c-0305e82c3301')).toBe(true);
  });
  it('rejects wrong length', () => { expect(isUuid('abc')).toBe(false); });
  it('rejects missing hyphens', () => { expect(isUuid('3f2504e04f8941d39a0c0305e82c3301')).toBe(false); });
  it('rejects non-hex characters', () => { expect(isUuid('zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz')).toBe(false); });
  it('rejects empty string', () => { expect(isUuid('')).toBe(false); });
});
