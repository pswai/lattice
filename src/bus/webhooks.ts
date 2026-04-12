import { createHmac } from 'node:crypto';
import type { DB } from './db.js';
import { log } from './logger.js';

export interface WebhookConfig {
  maxRetries?: number;
  initialRetryMs?: number;
}

interface WebhookRow {
  agent_id: string;
  url: string;
  secret: string;
}

interface DeadLetterMsg {
  id: number;
  from_agent: string;
  to_agent: string | null;
  topic: string | null;
  type: string;
  payload: Buffer;
  created_at: number;
}

export async function dispatchWebhook(
  db: DB,
  messageId: number,
  toAgent: string,
  payload: unknown,
  fromAgent: string,
  type: string,
  topic: string | null,
  correlationId: string | null,
  createdAt: number,
  config: WebhookConfig = {},
): Promise<boolean> {
  const row = db
    .prepare('SELECT agent_id, url, secret FROM bus_webhooks WHERE agent_id = ?')
    .get(toAgent) as WebhookRow | undefined;

  if (!row) return false;

  const maxRetries = config.maxRetries ?? 5;
  const initialRetryMs = config.initialRetryMs ?? 1000;

  const body = JSON.stringify({
    message_id: messageId,
    from: fromAgent,
    to: toAgent,
    type,
    topic,
    payload,
    correlation_id: correlationId,
    created_at: createdAt,
  });

  const signature = createHmac('sha256', row.secret)
    .update(body, 'utf8')
    .digest('hex');

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(row.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Lattice-Signature': `sha256=${signature}`,
          'X-Lattice-Message-Id': String(messageId),
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });

      if (response.ok) {
        log('info', 'webhook_delivered', {
          agent_id: toAgent,
          message_id: messageId,
          url: row.url,
          status: response.status,
          attempt,
        });
        return true;
      }

      log('warn', 'webhook_retry', {
        agent_id: toAgent,
        message_id: messageId,
        url: row.url,
        status: response.status,
        attempt,
      });
    } catch (err) {
      log('warn', 'webhook_retry', {
        agent_id: toAgent,
        message_id: messageId,
        url: row.url,
        error: err instanceof Error ? err.message : String(err),
        attempt,
      });
    }

    if (attempt < maxRetries) {
      const delay = initialRetryMs * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  // All retries exhausted — dead-letter
  log('error', 'webhook_permanent_failure', {
    agent_id: toAgent,
    message_id: messageId,
    url: row.url,
    maxRetries,
  });

  db.prepare(
    `INSERT INTO bus_dead_letters (message_id, from_agent, to_agent, topic, type, payload, reason, recorded_at)
     SELECT id, from_agent, to_agent, topic, type, payload, 'permanent_failure', ?
     FROM bus_messages WHERE id = ?`,
  ).run(Date.now(), messageId);

  return false;
}
