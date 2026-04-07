import type { DbAdapter } from '../db/adapter.js';
import type { Message, SendMessageInput, SendMessageResponse, GetMessagesInput, GetMessagesResponse } from './types.js';
import { throwIfSecretsFound } from '../services/secret-scanner.js';
import { safeJsonParse } from '../safe-json.js';

interface MessageRow {
  id: number;
  workspace_id: string;
  from_agent: string;
  to_agent: string;
  message: string;
  tags: string;
  created_at: string;
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
  };
}

export async function sendMessage(
  db: DbAdapter,
  workspaceId: string,
  fromAgent: string,
  input: SendMessageInput,
): Promise<SendMessageResponse> {
  // Scan message content for secrets
  throwIfSecretsFound(input.message);

  const result = await db.run(`
    INSERT INTO messages (workspace_id, from_agent, to_agent, message, tags)
    VALUES (?, ?, ?, ?, ?)
  `, workspaceId, fromAgent, input.to, input.message, JSON.stringify(input.tags));

  return { messageId: Number(result.lastInsertRowid) };
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
