// ABOUTME: Selects and memoises the Mailer backend named by config.MAIL_PROVIDER.
// ABOUTME: 'console' for dev/test; 'resend' for production delivery.
import type { Mailer } from './types';
import { ConsoleMailer } from './console';
import { config } from '@/config';

let cached: Mailer | undefined;

export function getMailer(): Mailer {
  if (cached) return cached;
  cached = config.MAIL_PROVIDER === 'resend'
    ? buildResend()
    : new ConsoleMailer();
  return cached;
}

function buildResend(): Mailer {
  throw new Error('ResendMailer not yet implemented');
}
