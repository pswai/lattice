import type { DbAdapter } from '../db/adapter.js';
import type { Message, SendMessageInput, SendMessageResponse, GetMessagesInput, GetMessagesResponse, WaitForMessageInput, WaitForMessageResponse } from './types.js';
import { safeJsonParse } from '../safe-json.js';
import { eventBus } from '../services/event-emitter.js';
import { sessionRegistry } from '../mcp/session-registry.js';
import { getLogger } from '../logger.js';

interface MessageRow {
  id: number;
  workspace_id: string;
  from_agent: string;
  to_agent: string;
  message: string;
  tags: string;
  created_at: string;
  reply_to: number | null;
}

function rowToMessage(row: MessageRow): Message {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    fromAgent: row.from_agent,
    toAgent: row.to_agent,
    message: row.message,
    tags: safeJsonParse<string[]>(row.tags, []),
    createdAt: row.created_at,
    replyTo: row.reply_to ?? null,
  };
}

export async function sendMessage(
  db: DbAdapter,
  workspaceId: string,
  fromAgent: string,
  input: SendMessageInput,
): Promise<SendMessageResponse> {
  const result = await db.run(`
    INSERT INTO messages (workspace_id, from_agent, to_agent, message, tags, reply_to)
    VALUES (?, ?, ?, ?, ?, ?)
  `, workspaceId, fromAgent, input.to, input.message, JSON.stringify(input.tags), input.reply_to ?? null);

  const messageId = Number(result.lastInsertRowid);
  eventBus.emit('message', { workspaceId, toAgent: input.to, messageId });

  // Push notification to recipient's active MCP session (if connected)
  const recipientSession = sessionRegistry.getSessionForAgent(workspaceId, input.to);
  if (recipientSession) {
    recipientSession.server.sendLoggingMessage({
      level: 'info',
      data: JSON.stringify({
        type: 'message_received',
        messageId,
        from: fromAgent,
        preview: input.message.slice(0, 200),
      }),
    }, recipientSession.sessionId).catch((err) => {
      getLogger().debug('mcp_push_failed', {
        messageId,
        toAgent: input.to,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  return { messageId };
}

export async function getMessages(
  db: DbAdapter,
  workspaceId: string,
  agentId: string,
  input: GetMessagesInput,
): Promise<GetMessagesResponse> {
  const limit = Math.min(input.limit ?? 50, 200);
  const sinceId = input.since_id ?? 0;

  const rows = await db.all<MessageRow>(`
    SELECT * FROM messages
    WHERE workspace_id = ? AND to_agent = ? AND id > ?
    ORDER BY id ASC
    LIMIT ?
  `, workspaceId, agentId, sinceId, limit);

  const messages = rows.map(rowToMessage);
  const cursor = messages.length > 0 ? messages[messages.length - 1].id : sinceId;

  return { messages, cursor };
}

/** Long-poll: block until a message arrives for the agent, or until timeout.
 *  Returns immediately if matching messages already exist after since_id. */
export async function waitForMessage(
  db: DbAdapter,
  workspaceId: string,
  agentId: string,
  input: WaitForMessageInput,
): Promise<WaitForMessageResponse> {
  const timeoutSec = Math.min(Math.max(input.timeout_sec ?? 30, 0), 60);

  const query = (): Promise<WaitForMessageResponse> =>
    getMessages(db, workspaceId, agentId, { since_id: input.since_id });

  // Fast path: already have messages waiting
  const initial = await query();
  if (initial.messages.length > 0) {
    return initial;
  }

  // Zero timeout — return empty immediately
  if (timeoutSec === 0) {
    return initial;
  }

  return new Promise<WaitForMessageResponse>((resolve) => {
    let settled = false;

    const cleanup = () => {
      eventBus.off('message', onMessage);
      clearTimeout(timer);
    };

    const finish = (result: WaitForMessageResponse) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const onMessage = (payload: { workspaceId: string; toAgent: string; messageId: number }) => {
      if (payload.workspaceId !== workspaceId) return;
      if (payload.toAgent !== agentId) return;
      if (payload.messageId <= input.since_id) return;
      query().then((result) => {
        if (result.messages.length > 0) {
          finish(result);
        }
      });
    };

    const timer = setTimeout(() => {
      finish({ messages: [], cursor: input.since_id });
    }, timeoutSec * 1000);

    eventBus.on('message', onMessage);
  });
}

/** Search messages involving an agent (sent or received) with optional text filter. */
export async function searchMessages(
  db: DbAdapter,
  workspaceId: string,
  agentId: string,
  input: { query?: string; with_agent?: string; limit?: number; since_id?: number },
): Promise<GetMessagesResponse> {
  const limit = Math.min(input.limit ?? 50, 200);
  const sinceId = input.since_id ?? 0;

  const conditions = ['workspace_id = ?', 'id > ?', '(from_agent = ? OR to_agent = ?)'];
  const params: (string | number)[] = [workspaceId, sinceId, agentId, agentId];

  if (input.with_agent) {
    conditions.push('(from_agent = ? OR to_agent = ?)');
    params.push(input.with_agent, input.with_agent);
  }

  if (input.query) {
    conditions.push('message LIKE ?');
    params.push(`%${input.query}%`);
  }

  params.push(limit);

  const rows = await db.all<MessageRow>(`
    SELECT * FROM messages
    WHERE ${conditions.join(' AND ')}
    ORDER BY id DESC
    LIMIT ?
  `, ...params);

  const messages = rows.map(rowToMessage);
  const cursor = messages.length > 0 ? messages[messages.length - 1].id : sinceId;
  return { messages, cursor };
}

/** Get all messages in a thread (the original message plus all replies). */
export async function getThread(
  db: DbAdapter,
  workspaceId: string,
  messageId: number,
): Promise<GetMessagesResponse> {
  const rows = await db.all<MessageRow>(`
    SELECT * FROM messages
    WHERE workspace_id = ? AND (id = ? OR reply_to = ?)
    ORDER BY id ASC
  `, workspaceId, messageId, messageId);
  const messages = rows.map(rowToMessage);
  const cursor = messages.length > 0 ? messages[messages.length - 1].id : 0;
  return { messages, cursor };
}
