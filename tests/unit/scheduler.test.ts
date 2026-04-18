import { describe, it, expect, vi } from 'vitest';

vi.mock('@/services/gc', () => ({
  sweepOrphans: vi.fn(async () => 0),
}));

describe('startOrphanSweep', () => {
  it('runs immediately and returns a cancel function', async () => {
    const { sweepOrphans } = await import('@/services/gc');
    const { startOrphanSweep } = await import('@/services/scheduler');
    const stop = startOrphanSweep({ intervalMs: 100 });
    await new Promise((r) => setTimeout(r, 10));
    expect((sweepOrphans as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBeGreaterThanOrEqual(1);
    stop();
  });

  it('can skip the immediate run', async () => {
    vi.clearAllMocks();
    const { sweepOrphans } = await import('@/services/gc');
    const { startOrphanSweep } = await import('@/services/scheduler');
    const stop = startOrphanSweep({ intervalMs: 10_000, runImmediately: false });
    expect((sweepOrphans as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(0);
    stop();
  });
});
