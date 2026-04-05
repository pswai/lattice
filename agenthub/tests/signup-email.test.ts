import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, testConfig } from './helpers.js';
import { createApp } from '../src/http/app.js';
import { createMcpServer } from '../src/mcp/server.js';
import {
  createEmailSender,
  getLastStubEmails,
  clearStubEmails,
} from '../src/services/email.js';

describe('signup → email', () => {
  beforeEach(() => {
    clearStubEmails();
  });

  it('signup triggers a stub email when sender is configured', async () => {
    const db = createTestDb();
    const config = testConfig();
    const sender = createEmailSender(config);
    const app = createApp(db, () => createMcpServer(db), config, sender);

    const res = await app.request('/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com', password: 'longpassword', name: 'Alice' }),
    });
    expect(res.status).toBe(201);
    const sent = getLastStubEmails();
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('alice@example.com');
    expect(sent[0].subject).toMatch(/verify/i);
  });

  it('email body contains the verify URL with the raw token', async () => {
    const db = createTestDb();
    const config = testConfig({ appBaseUrl: 'https://app.test.dev' });
    const sender = createEmailSender(config);
    const app = createApp(db, () => createMcpServer(db), config, sender);

    const res = await app.request('/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'bob@example.com', password: 'longpassword' }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { email_verification_token: string };
    const raw = json.email_verification_token;
    expect(raw).toBeTruthy();
    const sent = getLastStubEmails();
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toContain('https://app.test.dev/auth/verify-email?token=');
    expect(sent[0].body).toContain(raw);
  });

  it('no email is sent when sender is null (dev mode)', async () => {
    const db = createTestDb();
    const config = testConfig();
    const app = createApp(db, () => createMcpServer(db), config, null);

    const res = await app.request('/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@example.com', password: 'longpassword' }),
    });
    expect(res.status).toBe(201);
    expect(getLastStubEmails()).toHaveLength(0);
  });
});
