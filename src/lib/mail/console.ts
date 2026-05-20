// ABOUTME: Dev/test Mailer that captures messages in-memory for assertions instead of delivering.
// ABOUTME: Records only — no stdout — so test output stays pristine; the route logs sends via pino.
import type { Mailer, MailMessage } from './types';

export class ConsoleMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  async send(msg: MailMessage): Promise<void> {
    this.sent.push(msg);
  }
}
