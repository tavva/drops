// ABOUTME: In-process periodic task runner. Kicks the orphan sweep and expired-token cleanup
// ABOUTME: on startup, then every hour.
import { sweepOrphans } from './gc';
import { deleteExpiredMagicTokens } from './magicLinkTokens';
import { deleteExpiredCliAuthorizationCodes } from './cliAuth';

export interface ScheduleOpts {
  intervalMs?: number;
  runImmediately?: boolean;
  log?: (task: string, err: unknown) => void;
}

export function startOrphanSweep(opts: ScheduleOpts = {}): () => void {
  const interval = opts.intervalMs ?? 3_600_000;
  const log = opts.log ?? ((task, err) => console.error(`${task} failed`, err));
  const tick = () => {
    sweepOrphans().catch((err) => log('orphan sweep', err));
    deleteExpiredMagicTokens().catch((err) => log('magic-token cleanup', err));
    deleteExpiredCliAuthorizationCodes().catch((err) => log('CLI-authorisation cleanup', err));
  };
  if (opts.runImmediately !== false) tick();
  const handle = setInterval(tick, interval);
  handle.unref?.();
  return () => clearInterval(handle);
}
