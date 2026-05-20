// ABOUTME: Mailer interface — the one seam every email send goes through.
// ABOUTME: Backends are selected by config; see ./index.ts getMailer().
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  send(msg: MailMessage): Promise<void>;
}
