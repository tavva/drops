// ABOUTME: Failure-path tests for child-process tracking used by the CLI Playwright system test.
// ABOUTME: Proves timed-out and stubborn children are reaped without leaving occupied ports.
import { createServer } from 'node:net';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { ChildProcessTracker, spawnWithResult } from '../e2e/helpers/processes';

async function canListen(port: number): Promise<boolean> {
  const server = createServer();
  try {
    server.listen(port, '127.0.0.1');
    await once(server, 'listening');
    return true;
  } catch {
    return false;
  } finally {
    if (server.listening) server.close();
  }
}

describe('CLI E2E child lifecycle', () => {
  it('kills a timed-out child and releases its listening port', async () => {
    const tracker = new ChildProcessTracker({ terminateTimeoutMs: 50, killTimeoutMs: 500 });
    const script = [
      "const server=require('node:net').createServer().listen(0,'127.0.0.1',()=>console.log(server.address().port));",
      "process.on('SIGTERM',()=>{});",
    ].join('');
    let observedPort = 0;

    await expect(spawnWithResult(process.execPath, ['-e', script], {
      tracker,
      timeoutMs: 150,
      onStdout: (stdout) => { observedPort = Number(stdout.trim()); },
    })).rejects.toThrow('timed out');

    expect(observedPort).toBeGreaterThan(0);
    expect(tracker.size).toBe(0);
    await expect(canListen(observedPort)).resolves.toBe(true);
  });

  it('terminates every tracked child on cleanup', async () => {
    const tracker = new ChildProcessTracker({ terminateTimeoutMs: 50, killTimeoutMs: 500 });
    tracker.spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"]);
    tracker.spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);

    await tracker.terminateAll();

    expect(tracker.size).toBe(0);
  });
});
