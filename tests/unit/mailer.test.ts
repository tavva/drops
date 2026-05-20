// ABOUTME: ConsoleMailer records sent messages so tests can assert on magic-link delivery.
import { describe, it, expect } from 'vitest';
import { ConsoleMailer } from '@/lib/mail/console';

describe('ConsoleMailer', () => {
  it('records each sent message', async () => {
    const m = new ConsoleMailer();
    await m.send({ to: 'a@b.com', subject: 'Hi', text: 'link', html: '<a>link</a>' });
    expect(m.sent).toHaveLength(1);
    expect(m.sent[0]).toMatchObject({ to: 'a@b.com', subject: 'Hi' });
  });
});
