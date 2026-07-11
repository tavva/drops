// ABOUTME: Implements repository-local Drops CLI instance initialisation.
// ABOUTME: Keeps command parsing separate from portable .drops.json creation.
import { initialiseConfig } from '../config.js';

export interface InitCommandOptions {
  cwd: string;
  instance: string;
  force: boolean;
}

export async function runInitCommand(options: InitCommandOptions): Promise<{ path: string; instance: string }> {
  return initialiseConfig(options);
}
