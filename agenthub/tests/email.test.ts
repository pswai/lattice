import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createEmailSender,
  getLastStubEmails,
  clearStubEmails,
} from '../src/services/email.js';
import { testConfig } from './helpers.js';

describe('email service', () => {
  beforeEach(() => {
    clearStubEmails();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearStubEmails();
  });

  it('stub sender stores sent emails in getLastStubEmails', async () => {
    const sender = createEmailSender(testConfig({ emailProvider: 'stub' }));
    await sender.send('alice@example.com', 'Hi', 'Body A');
    await sender.send('bob@example.com', 'Hi 2', 'Body B');
    const sent = getLastStubEmails();
    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual({ to: 'alice@example.com', subject: 'Hi', body: 'Body A' });
    expect(sent[1].to).toBe('bob@example.com');
  });

  it('clearStubEmails resets the stored list', async () => {
    const sender = createEmailSender(testConfig({ emailProvider: 'stub' }));
    await sender.send('a@b.com', 's', 'b');
    expect(getLastStubEmails()).toHaveLength(1);
    clearStubEmails();
    expect(getLastStubEmails()).toHaveLength(0);
  });

  it('Resend adapter POSTs to the correct URL with Bearer header', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ id: 'abc' }), { status: 200 }));
    const sender = createEmailSender(
      testConfig({
        emailProvider: 'resend',
        emailResendApiKey: 'key_xyz',
        emailFromAddress: 'noreply@test.dev',
      }),
    );
    await sender.send('to@example.com', 'Subject', 'Body text');
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer key_xyz');
    expect(headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(init?.body as string) as {
      from: string;
      to: string;
      subject: string;
      text: string;
    };
    expect(body.from).toBe('noreply@test.dev');
    expect(body.to).toBe('to@example.com');
    expect(body.subject).toBe('Subject');
    expect(body.text).toBe('Body text');
  });

  it('Resend adapter propagates non-2xx as an error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('bad key', { status: 401 }),
    );
    const sender = createEmailSender(
      testConfig({ emailProvider: 'resend', emailResendApiKey: 'bad' }),
    );
    await expect(sender.send('to@example.com', 's', 'b')).rejects.toThrow(/401/);
  });

  it('throws when emailProvider=resend but no apiKey', () => {
    expect(() =>
      createEmailSender(testConfig({ emailProvider: 'resend', emailResendApiKey: '' })),
    ).toThrow('RESEND_API_KEY is not set');
  });

  it('stub sender returns a resolved promise', async () => {
    const sender = createEmailSender(testConfig({ emailProvider: 'stub' }));
    const result = sender.send('a@b.com', 's', 'b');
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBeUndefined();
  });
});
