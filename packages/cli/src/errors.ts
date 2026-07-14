// ABOUTME: Defines the stable Drops CLI error payload and coarse process exit categories.
// ABOUTME: Keeps machine-readable failures consistent across commands and output modes.
export type DropsCliExitCode = 2 | 3 | 4 | 5 | 6;

export const EXIT_CODES = {
  success: 0,
  usage: 2,
  auth: 3,
  upload: 4,
  network: 5,
  internal: 6,
} as const;

export type DropsCliErrorDetails = Record<string, unknown> | null;

export interface DropsCliErrorGuidance {
  usage?: string;
  hint?: string;
  examples?: string[];
}

export interface ResolvedDropsCliErrorGuidance {
  usage: string | null;
  hint: string | null;
  examples: string[];
}

export interface DropsCliErrorOptions {
  code: string;
  message: string;
  instance?: string | null;
  details?: DropsCliErrorDetails;
  guidance?: DropsCliErrorGuidance;
  exitCode: DropsCliExitCode;
}

export class DropsCliError extends Error {
  readonly code: string;
  readonly instance: string | null;
  readonly details: DropsCliErrorDetails;
  readonly guidance: ResolvedDropsCliErrorGuidance;
  readonly exitCode: DropsCliExitCode;

  constructor(options: DropsCliErrorOptions) {
    super(options.message);
    this.name = 'DropsCliError';
    this.code = options.code;
    this.instance = options.instance ?? null;
    this.details = options.details ?? null;
    this.guidance = {
      usage: options.guidance?.usage ?? null,
      hint: options.guidance?.hint ?? null,
      examples: [...(options.guidance?.examples ?? [])],
    };
    this.exitCode = options.exitCode;
  }
}
