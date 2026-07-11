// ABOUTME: In-process periodic task runner. Kicks the orphan sweep and expired-token cleanup
// ABOUTME: on startup, then every hour.
import { sweepOrphans } from './gc';
import { deleteExpiredMagicTokens } from './magicLinkTokens';
import { deleteExpiredCliAuthorizationCodes } from './cliAuth';

export interface ScheduleOpts {
  intervalMs?: number;
  runImmediately?: boolean;
  log?: (err: unknown) => void;
}

export function startOrphanSweep(opts: ScheduleOpts = {}): () => void {
  const interval = opts.intervalMs ?? 3_600_000;
  const log = opts.log ?? ((err) => console.error('orphan sweep failed', err));
  const tick = () => {
    sweepOrphans().catch(log);
    deleteExpiredMagicTokens().catch(log);
    deleteExpiredCliAuthorizationCodes().catch(log);
  };
  if (opts.runImmediately !== false) tick();
  const handle = setInterval(tick, interval);
  handle.unref?.();
  return () => clearInterval(handle);
}
