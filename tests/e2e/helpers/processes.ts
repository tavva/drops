// ABOUTME: Tracks every child process used by CLI Playwright tests and bounds all waits.
// ABOUTME: Cleanup escalates from SIGTERM to SIGKILL and always awaits the child close event.
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

export type SpawnResult = { exitCode: number; stdout: string; stderr: string };

type TrackerOptions = {
  terminateTimeoutMs?: number;
  killTimeoutMs?: number;
};

function closed(child: ChildProcess): Promise<'closed'> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve('closed');
  return new Promise((resolve) => child.once('close', () => resolve('closed')));
}

async function waitForClose(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      closed(child).then(() => true),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class ChildProcessTracker {
  private readonly children = new Set<ChildProcess>();
  private readonly terminateTimeoutMs: number;
  private readonly killTimeoutMs: number;

  constructor(options: TrackerOptions = {}) {
    this.terminateTimeoutMs = options.terminateTimeoutMs ?? 1_000;
    this.killTimeoutMs = options.killTimeoutMs ?? 2_000;
  }

  get size(): number { return this.children.size; }

  spawn(command: string, args: string[], options: SpawnOptions = {}): ChildProcess {
    return this.track(spawn(command, args, options));
  }

  track(child: ChildProcess): ChildProcess {
    this.children.add(child);
    child.once('close', () => this.children.delete(child));
    return child;
  }

  async terminate(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) {
      this.children.delete(child);
      return;
    }

    child.kill('SIGTERM');
    if (await waitForClose(child, this.terminateTimeoutMs)) return;

    child.kill('SIGKILL');
    if (!await waitForClose(child, this.killTimeoutMs)) {
      throw new Error(`Child process ${child.pid ?? 'unknown'} did not exit after SIGKILL`);
    }
  }

  async terminateAll(): Promise<void> {
    const children = [...this.children];
    const results = await Promise.allSettled(children.map((child) => this.terminate(child)));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) throw failure.reason;
  }
}

export function spawnWithResult(
  command: string,
  args: string[],
  options: SpawnOptions & {
    tracker: ChildProcessTracker;
    timeoutMs: number;
    onStdout?: (stdout: string) => void;
  },
): Promise<SpawnResult> {
  const { tracker, timeoutMs, onStdout, ...spawnOptions } = options;
  const child = tracker.spawn(command, args, { ...spawnOptions, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let timedOut = false;

  child.stdout!.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
    onStdout?.(stdout);
  });
  child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(async () => {
      timedOut = true;
      try {
        await tracker.terminate(child);
        reject(new Error(`Child process timed out after ${timeoutMs}ms`));
      } catch (error) {
        reject(error);
      }
    }, timeoutMs);

    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (exitCode) => {
      clearTimeout(timer);
      if (!timedOut) resolve({ exitCode: exitCode ?? 1, stdout, stderr });
    });
  });
}
