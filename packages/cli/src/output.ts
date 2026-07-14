// ABOUTME: Emits the Drops CLI's stable machine-readable and human-readable output formats.
// ABOUTME: Isolates final results on stdout, diagnostics on stderr, and redacts bearer-looking tokens.
import { DropsCliError, EXIT_CODES } from './errors.js';

export interface TextWriter {
  write(chunk: string): unknown;
}

export interface OutputOptions {
  json: boolean;
  stdout: TextWriter;
  stderr: TextWriter;
}

const TOKEN_PATTERN = /drops_cli_[A-Za-z0-9._~-]+/g;

export function redactSecrets(value: string): string {
  return value.replace(TOKEN_PATTERN, '[REDACTED]');
}

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactValue(child)]));
  }
  return value;
}

export interface DropsOutput {
  success(value: Record<string, unknown>, humanMessage?: string): 0;
  error(error: DropsCliError): DropsCliError['exitCode'];
  diagnostic(message: string): void;
}

export function createOutput(options: OutputOptions): DropsOutput {
  return {
    success(value, humanMessage) {
      if (options.json) {
        options.stdout.write(`${JSON.stringify(redactValue(value))}\n`);
      } else {
        options.stdout.write(`${redactSecrets(humanMessage ?? JSON.stringify(value))}\n`);
      }
      return EXIT_CODES.success;
    },

    error(error) {
      if (options.json) {
        options.stdout.write(
          `${JSON.stringify({
            error: {
              code: error.code,
              message: redactSecrets(error.message),
              instance: error.instance === null ? null : redactSecrets(error.instance),
              details: redactValue(error.details),
              usage: error.guidance.usage === null ? null : redactSecrets(error.guidance.usage),
              hint: error.guidance.hint === null ? null : redactSecrets(error.guidance.hint),
              examples: error.guidance.examples.map(redactSecrets),
            },
          })}\n`,
        );
      } else {
        const lines = [`Error [${error.code}]: ${redactSecrets(error.message)}`];
        if (error.guidance.usage !== null) lines.push(`Usage: ${redactSecrets(error.guidance.usage)}`);
        if (error.guidance.hint !== null) lines.push(`Hint: ${redactSecrets(error.guidance.hint)}`);
        if (error.guidance.examples.length > 0) {
          lines.push('Examples:', ...error.guidance.examples.map((example) => `  ${redactSecrets(example)}`));
        }
        options.stderr.write(`${lines.join('\n')}\n`);
      }
      return error.exitCode;
    },

    diagnostic(message) {
      options.stderr.write(`${redactSecrets(message)}\n`);
    },
  };
}
