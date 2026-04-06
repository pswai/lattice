import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, testConfig } from './helpers.js';
import { createApp } from '../src/http/app.js';
import { createMcpServer } from '../src/mcp/server.js';
import {
  createEmailSender,
  getLastStubEmails,
  clearStubEmails,
} from '../src/services/email.js';
import type { Hono } from 'hono';

function extractSessionCookie(res: Response): string {
  const h = res.headers.get('set-cookie') || '';
  const m = h.match(/lt_session=([^;]*)/);
  return m ? m[1] : '';
}

async function signup(app: Hono, email: string): Promise<string> {
  const res = await app.request('/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'longenough-pass' }),
  });
  expect(res.status).toBe(201);
  return extractSessionCookie(res);
}

describe('invite → email', () => {
  beforeEach(() => {
    clearStubEmails();
  });

  it('POST /workspaces/:id/invites triggers a stub email with accept URL', async () => {
    const db = createTestDb();
    const config = testConfig({ appBaseUrl: 'https://app.test.dev' });
    const sender = createEmailSender(config);
    const app = createApp(db, () => createMcpServer(db), config, sender);

    const cookie = await signup(app, 'owner@example.com');
    clearStubEmails(); // drop signup verify email
    const createRes = await app.request('/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `lt_session=${cookie}` },
      body: JSON.stringify({ id: 'ws1', name: 'ws1' }),
    });
    expect(createRes.status).toBe(201);

    const inviteRes = await app.request('/workspaces/ws1/invites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `lt_session=${cookie}` },
      body: JSON.stringify({ email: 'invitee@example.com', role: 'member' }),
    });
    expect(inviteRes.status).toBe(201);
    const body = (await inviteRes.json()) as { invite_token: string };
    const raw = body.invite_token;

    const sent = getLastStubEmails();
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('invitee@example.com');
    expect(sent[0].body).toContain('https://app.test.dev/workspaces/invites/accept?token=');
    expect(sent[0].body).toContain(raw);
  });

  it('no invite email sent when sender is null', async () => {
    const db = createTestDb();
    const config = testConfig();
    const app = createApp(db, () => createMcpServer(db), config, null);

    const cookie = await signup(app, 'owner2@example.com');
    await app.request('/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `lt_session=${cookie}` },
      body: JSON.stringify({ id: 'ws2', name: 'ws2' }),
    });
    const inviteRes = await app.request('/workspaces/ws2/invites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `lt_session=${cookie}` },
      body: JSON.stringify({ email: 'nobody@example.com', role: 'viewer' }),
    });
    expect(inviteRes.status).toBe(201);
    expect(getLastStubEmails()).toHaveLength(0);
  });
});
