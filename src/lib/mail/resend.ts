// ABOUTME: Production Mailer backed by the Resend HTTP API via fetch (no SDK).
// ABOUTME: Throws on non-2xx so callers can log; the request route still shows a neutral notice.
import type { Mailer, MailMessage } from './types';

export class ResendMailer implements Mailer {
  constructor(private readonly apiKey: string, private readonly from: string) {}

  async send(msg: MailMessage): Promise<void> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: this.from,
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
      }),
    });
    if (!res.ok) {
      throw new Error(`resend send failed: ${res.status}`);
    }
  }
}
