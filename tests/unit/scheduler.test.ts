import { describe, it, expect, vi } from 'vitest';

vi.mock('@/services/gc', () => ({
  sweepOrphans: vi.fn(async () => 0),
}));
vi.mock('@/services/magicLinkTokens', () => ({
  deleteExpiredMagicTokens: vi.fn(async () => undefined),
}));
vi.mock('@/services/cliAuth', () => ({
  deleteExpiredCliAuthorizationCodes: vi.fn(async () => 0),
}));

describe('startOrphanSweep', () => {
  it('runs immediately and returns a cancel function', async () => {
    const { sweepOrphans } = await import('@/services/gc');
    const { deleteExpiredMagicTokens } = await import('@/services/magicLinkTokens');
    const { deleteExpiredCliAuthorizationCodes } = await import('@/services/cliAuth');
    const { startOrphanSweep } = await import('@/services/scheduler');
    const stop = startOrphanSweep({ intervalMs: 100 });
    await new Promise((r) => setTimeout(r, 10));
    expect((sweepOrphans as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(deleteExpiredMagicTokens).toHaveBeenCalled();
    expect(deleteExpiredCliAuthorizationCodes).toHaveBeenCalled();
    stop();
  });

  it('identifies each failing maintenance task in logs', async () => {
    vi.clearAllMocks();
    const { sweepOrphans } = await import('@/services/gc');
    const { deleteExpiredMagicTokens } = await import('@/services/magicLinkTokens');
    const { deleteExpiredCliAuthorizationCodes } = await import('@/services/cliAuth');
    vi.mocked(sweepOrphans).mockRejectedValueOnce(new Error('gc failed'));
    vi.mocked(deleteExpiredMagicTokens).mockRejectedValueOnce(new Error('magic failed'));
    vi.mocked(deleteExpiredCliAuthorizationCodes).mockRejectedValueOnce(new Error('cli failed'));
    const log = vi.fn();
    const { startOrphanSweep } = await import('@/services/scheduler');
    const stop = startOrphanSweep({ intervalMs: 10_000, log });
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(3));
    expect(log.mock.calls.map(([task]) => task)).toEqual([
      'orphan sweep',
      'magic-token cleanup',
      'CLI-authorisation cleanup',
    ]);
    stop();
  });

  it('can skip the immediate run', async () => {
    vi.clearAllMocks();
    const { sweepOrphans } = await import('@/services/gc');
    const { deleteExpiredMagicTokens } = await import('@/services/magicLinkTokens');
    const { deleteExpiredCliAuthorizationCodes } = await import('@/services/cliAuth');
    const { startOrphanSweep } = await import('@/services/scheduler');
    const stop = startOrphanSweep({ intervalMs: 10_000, runImmediately: false });
    expect((sweepOrphans as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(0);
    expect(deleteExpiredMagicTokens).not.toHaveBeenCalled();
    expect(deleteExpiredCliAuthorizationCodes).not.toHaveBeenCalled();
    stop();
  });
});
