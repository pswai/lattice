/**
 * Pluggable email delivery.
 *
 * - Stub sender: logs the email via the structured logger and retains the
 *   last N sends in-memory for test assertions. Always safe to use, no
 *   external network.
 * - Resend sender: POSTs to https://api.resend.com/emails via globalThis.fetch
 *   (Node 20+). No new dependencies.
 *
 * The app is expected to build exactly one EmailSender at startup and
 * pass it into route factories. A null sender means "skip email" (dev mode).
 */

import type { AppConfig } from '../config.js';
import { getLogger } from '../logger.js';

export interface EmailSender {
  send(to: string, subject: string, body: string): Promise<void>;
}

export interface StubEmailRecord {
  to: string;
  subject: string;
  body: string;
}

const STUB_LOG: StubEmailRecord[] = [];
const STUB_MAX = 100;

export function getLastStubEmails(): StubEmailRecord[] {
  return STUB_LOG.slice();
}

export function clearStubEmails(): void {
  STUB_LOG.length = 0;
}

class StubEmailSender implements EmailSender {
  async send(to: string, subject: string, body: string): Promise<void> {
    STUB_LOG.push({ to, subject, body });
    if (STUB_LOG.length > STUB_MAX) STUB_LOG.shift();
    getLogger().info('email_stub_send', { to, subject, body_length: body.length });
  }
}

class ResendEmailSender implements EmailSender {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(to: string, subject: string, body: string): Promise<void> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: this.from,
        to,
        subject,
        text: body,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Resend send failed: ${res.status} ${text}`);
    }
  }
}

export function createEmailSender(config: AppConfig): EmailSender {
  if (config.emailProvider === 'resend') {
    if (!config.emailResendApiKey) {
      // Misconfiguration: resend chosen but no key. Log and fall back to stub
      // so signup/invite don't blow up in production.
      getLogger().warn('email_resend_missing_key_fallback_stub');
      return new StubEmailSender();
    }
    return new ResendEmailSender(config.emailResendApiKey, config.emailFromAddress);
  }
  return new StubEmailSender();
}
