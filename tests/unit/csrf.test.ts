import { describe, it, expect } from 'vitest';
import { issueCsrfToken, verifyCsrfToken, originMatches } from '@/lib/csrf';

describe('CSRF tokens', () => {
  it('round-trips for the same context id', () => {
    const t = issueCsrfToken('ctx-1');
    expect(verifyCsrfToken('ctx-1', t)).toBe(true);
  });

  it('rejects a token bound to another context', () => {
    const t = issueCsrfToken('ctx-1');
    expect(verifyCsrfToken('ctx-2', t)).toBe(false);
  });

  it('rejects malformed tokens', () => {
    expect(verifyCsrfToken('ctx', '')).toBe(false);
    expect(verifyCsrfToken('ctx', 'nope')).toBe(false);
    expect(verifyCsrfToken('ctx', '.sig')).toBe(false);
  });
});

describe('originMatches', () => {
  it('accepts exact origin match', () => {
    expect(originMatches('http://drops.localtest.me:3000')).toBe(true);
    expect(originMatches('http://drops.localtest.me:3000/page')).toBe(true);
  });
  it('rejects extra subdomain', () => {
    expect(originMatches('http://drops.localtest.me.evil.com')).toBe(false);
  });
  it('rejects missing header', () => {
    expect(originMatches(undefined)).toBe(false);
    expect(originMatches('')).toBe(false);
  });
  it('rejects different scheme', () => {
    expect(originMatches('https://drops.localtest.me:3000')).toBe(false);
  });
});
