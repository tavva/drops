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

export function notAuthenticatedError(origin: string, action: string): DropsCliError {
  return new DropsCliError({
    code: 'not_authenticated',
    message: `This Mac is not authenticated to ${origin}.`,
    instance: origin,
    guidance: {
      hint: `Authenticate this exact instance before ${action}.`,
      examples: [`drops login ${origin}`],
    },
    exitCode: 3,
  });
}

export function invalidDropNameError(name: string, example: string): DropsCliError {
  return new DropsCliError({
    code: 'invalid_name',
    message: 'The drop name must be a valid slug',
    details: { name },
    guidance: {
      hint: 'Use lowercase letters, numbers, and single hyphens; names must start and end with a letter or number.',
      examples: [example],
    },
    exitCode: 2,
  });
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
