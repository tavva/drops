// ABOUTME: Stores one Drops CLI bearer credential per canonical origin in macOS Keychain.
// ABOUTME: Keeps secrets off process arguments and maps Keychain failures to stable CLI errors.
import { spawn } from 'node:child_process';

import { DropsCliError } from './errors.js';

const KEYCHAIN_SERVICE = 'global.drops.cli';
const SECURITY_EXECUTABLE = '/usr/bin/security';
const MAX_OUTPUT_BYTES = 8 * 1024;

export interface CredentialStore {
  get(origin: string): Promise<string | null>;
  set(origin: string, token: string): Promise<void>;
  delete(origin: string): Promise<void>;
}

export interface ProcessRequest {
  command: string;
  args: string[];
  stdin?: string;
}

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ProcessRunner = (request: ProcessRequest) => Promise<ProcessResult>;

function appendBounded(current: Buffer, chunk: Buffer): Buffer {
  if (current.length >= MAX_OUTPUT_BYTES) return current;
  return Buffer.concat([current, chunk.subarray(0, MAX_OUTPUT_BYTES - current.length)]);
}

export const runProcess: ProcessRunner = ({ command, args, stdin }) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.once('error', reject);
    child.once('close', (exitCode) => {
      resolve({
        exitCode: exitCode ?? 1,
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
      });
    });

    child.stdin.end(stdin);
  });

function unavailable(): DropsCliError {
  return new DropsCliError({
    code: 'keychain_unavailable',
    message: 'macOS Keychain is unavailable',
    exitCode: 3,
  });
}

function itemNotFound(result: ProcessResult): boolean {
  return result.exitCode === 44 || /(?:could not be found|errSecItemNotFound)/i.test(result.stderr);
}

export class MacOsKeychainStore implements CredentialStore {
  constructor(private readonly runner: ProcessRunner = runProcess) {}

  async get(origin: string): Promise<string | null> {
    const result = await this.execute({
      command: SECURITY_EXECUTABLE,
      args: ['find-generic-password', '-a', origin, '-s', KEYCHAIN_SERVICE, '-w'],
    });
    if (itemNotFound(result)) return null;
    if (result.exitCode !== 0) throw unavailable();
    return result.stdout.replace(/\r?\n$/, '');
  }

  async set(origin: string, token: string): Promise<void> {
    const result = await this.execute({
      command: SECURITY_EXECUTABLE,
      args: ['add-generic-password', '-a', origin, '-s', KEYCHAIN_SERVICE, '-U', '-w'],
      stdin: `${token}\n${token}\n`,
    });
    if (result.exitCode !== 0) throw unavailable();

    let verified = false;
    try {
      verified = (await this.get(origin)) === token;
    } catch {
      // Cleanup below handles a write whose read-back could not be verified.
    }
    if (!verified) {
      try {
        await this.delete(origin);
      } catch {
        // The write still must fail even when best-effort cleanup is unavailable.
      }
      throw unavailable();
    }
  }

  async delete(origin: string): Promise<void> {
    const result = await this.execute({
      command: SECURITY_EXECUTABLE,
      args: ['delete-generic-password', '-a', origin, '-s', KEYCHAIN_SERVICE],
    });
    if (itemNotFound(result)) return;
    if (result.exitCode !== 0) throw unavailable();
  }

  private async execute(request: ProcessRequest): Promise<ProcessResult> {
    try {
      return await this.runner(request);
    } catch {
      throw unavailable();
    }
  }
}
