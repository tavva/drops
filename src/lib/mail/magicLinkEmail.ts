// ABOUTME: Builds the viewer magic sign-in email — subject, plain-text and branded HTML bodies.
// ABOUTME: Pure function (no transport) so the content is unit-testable; sending lives in ./resend.ts.
import type { MailMessage } from './types';

export interface MagicLinkEmailParams {
  link: string;
  dropHost: string;
  expiresMinutes: number;
}

const BRAND = '#ff5a3c';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function expiry(minutes: number): string {
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

export type MagicLinkEmailContent = Omit<MailMessage, 'to'>;

export function magicLinkEmail({ link, dropHost, expiresMinutes }: MagicLinkEmailParams): MagicLinkEmailContent {
  const expires = expiry(expiresMinutes);
  const host = escapeHtml(dropHost);
  const href = escapeHtml(link);

  const text =
    `Hello,\n\n` +
    `You asked to sign in to view this drop:\n` +
    `  ${dropHost}\n\n` +
    `Open this link to sign in:\n` +
    `  ${link}\n\n` +
    `The link expires in ${expires} and can only be used once.\n\n` +
    `If you didn't request this, you can safely ignore this email — nobody can ` +
    `sign in without the link above.\n\n` +
    `— drops`;

  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#f4f4f5;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">Your sign-in link for ${host} — expires in ${expires}.</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:460px;background:#ffffff;border-radius:14px;border:1px solid #e7e7e9;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
            <tr>
              <td style="padding:28px 32px 8px;">
                <span style="font-size:20px;font-weight:700;letter-spacing:-0.02em;color:#18181b;">drops<span style="color:${BRAND};">.</span></span>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 32px 0;">
                <h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;font-weight:700;color:#18181b;">Your sign-in link</h1>
                <p style="margin:0 0 4px;font-size:15px;line-height:1.6;color:#3f3f46;">You asked to sign in to view this drop:</p>
                <p style="margin:0 0 24px;font-size:14px;line-height:1.5;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#52525b;word-break:break-all;">${host}</p>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:0 32px;">
                <table role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="border-radius:10px;background:${BRAND};">
                      <a href="${href}" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px;">Sign in to view →</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 32px 0;">
                <p style="margin:0 0 6px;font-size:13px;line-height:1.6;color:#71717a;">This link expires in <strong>${expires}</strong> and can only be used once.</p>
                <p style="margin:0;font-size:13px;line-height:1.6;color:#71717a;">If the button doesn't work, copy and paste this link into your browser:</p>
                <p style="margin:6px 0 0;font-size:12px;line-height:1.5;color:#a1a1aa;word-break:break-all;"><a href="${href}" style="color:#a1a1aa;">${href}</a></p>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 32px 28px;">
                <hr style="border:none;border-top:1px solid #ececee;margin:0 0 16px;">
                <p style="margin:0;font-size:12px;line-height:1.6;color:#a1a1aa;">If you didn't request this, you can safely ignore this email — nobody can sign in without the link above.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return {
    subject: 'Your drops sign-in link',
    text,
    html,
  };
}
