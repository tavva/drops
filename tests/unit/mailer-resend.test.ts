// ABOUTME: ResendMailer POSTs to the Resend API and throws on non-2xx responses.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ResendMailer } from '@/lib/mail/resend';

afterEach(() => vi.restoreAllMocks());

describe('ResendMailer', () => {
  it('POSTs to Resend with auth header and from address', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"id":"x"}', { status: 200 }),
    );
    const m = new ResendMailer('rk_test', 'drops@example.com');
    await m.send({ to: 'a@b.com', subject: 'Hi', text: 't', html: '<p>t</p>' });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://api.resend.com/emails');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer rk_test');
    expect(JSON.parse(init!.body as string)).toMatchObject({ from: 'drops@example.com', to: 'a@b.com' });
  });

  it('throws on non-2xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 422 }));
    const m = new ResendMailer('rk_test', 'drops@example.com');
    await expect(m.send({ to: 'a@b.com', subject: 'Hi', text: 't', html: '<p>t</p>' }))
      .rejects.toThrow(/422/);
  });
});
