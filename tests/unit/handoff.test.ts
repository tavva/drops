// ABOUTME: Unit tests for host-bound handoff tokens.
// ABOUTME: Tokens bind (sessionId, host, exp); verification requires the expected host to match.
import { describe, it, expect, vi } from 'vitest';
import { signHandoff, verifyHandoff } from '@/lib/handoff';

const key = 'k'.repeat(32);
const host = 'alice--foo.content.localtest.me';

describe('handoff token', () => {
  it('round-trips a session id within TTL when host matches', () => {
    const token = signHandoff('session-id', host, key, 60);
    expect(verifyHandoff(token, host, key)).toEqual({ ok: true, sessionId: 'session-id' });
  });

  it('rejects a token minted for a different host', () => {
    const token = signHandoff('session-id', host, key, 60);
    expect(verifyHandoff(token, 'bob--bar.content.localtest.me', key)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects after expiry', () => {
    const now = Date.now();
    vi.useFakeTimers(); vi.setSystemTime(now);
    const token = signHandoff('session-id', host, key, 1);
    vi.setSystemTime(now + 2_000);
    expect(verifyHandoff(token, host, key)).toEqual({ ok: false, reason: 'expired' });
    vi.useRealTimers();
  });

  it('rejects a tampered signature', () => {
    const token = signHandoff('session-id', host, key, 60);
    const bad = token.slice(0, -2) + 'xx';
    expect(verifyHandoff(bad, host, key)).toEqual({ ok: false, reason: 'invalid' });
  });
});
