// ABOUTME: magicLinkEmail builds the viewer sign-in email — assert subject, text and html content.
// ABOUTME: Content lives in a pure builder so it is testable without a live mail transport.
import { describe, it, expect } from 'vitest';
import { magicLinkEmail } from '@/lib/mail/magicLinkEmail';

const LINK = 'https://drops.example.com/auth/magic/verify?token=abc';
const HOST = 'alice--foo.content.example.com';

describe('magicLinkEmail', () => {
  const mail = magicLinkEmail({ link: LINK, dropHost: HOST, expiresMinutes: 15 });

  it('has a friendly, descriptive subject', () => {
    expect(mail.subject).toBe('Your drops sign-in link');
  });

  it('text body names the drop, carries the link and the expiry, and reassures', () => {
    expect(mail.text).toContain(HOST);
    expect(mail.text).toContain(LINK);
    expect(mail.text).toContain('15 minutes');
    expect(mail.text.toLowerCase()).toContain("didn't request");
  });

  it('html body uses the link as the button href and shows it as a fallback', () => {
    expect(mail.html).toContain(`href="${LINK}"`);
    expect(mail.html).toContain(HOST);
    expect(mail.html).toContain('15 minutes');
    expect(mail.html.toLowerCase()).toContain("didn't request");
  });

  it('html escapes the drop host to avoid injection from the host string', () => {
    const evil = magicLinkEmail({ link: LINK, dropHost: 'a<b>"&', expiresMinutes: 15 });
    expect(evil.html).not.toContain('<b>');
    expect(evil.html).toContain('a&lt;b&gt;&quot;&amp;');
  });

  it('singularises the expiry when only one minute remains', () => {
    const one = magicLinkEmail({ link: LINK, dropHost: HOST, expiresMinutes: 1 });
    expect(one.text).toContain('1 minute');
    expect(one.text).not.toContain('1 minutes');
  });
});
