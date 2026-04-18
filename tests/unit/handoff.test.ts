import { describe, it, expect, vi } from 'vitest';
import { signHandoff, verifyHandoff } from '@/lib/handoff';

const key = 'k'.repeat(32);

describe('handoff token', () => {
  it('round-trips a session id within TTL', () => {
    const token = signHandoff('session-id', key, 60);
    expect(verifyHandoff(token, key)).toEqual({ ok: true, sessionId: 'session-id' });
  });
  it('rejects after expiry', () => {
    const now = Date.now();
    vi.useFakeTimers(); vi.setSystemTime(now);
    const token = signHandoff('session-id', key, 1);
    vi.setSystemTime(now + 2_000);
    expect(verifyHandoff(token, key)).toEqual({ ok: false, reason: 'expired' });
    vi.useRealTimers();
  });
  it('rejects a tampered signature', () => {
    const token = signHandoff('session-id', key, 60);
    const bad = token.slice(0, -2) + 'xx';
    expect(verifyHandoff(bad, key)).toEqual({ ok: false, reason: 'invalid' });
  });
});
