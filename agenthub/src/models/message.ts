import type Database from 'better-sqlite3';
import type { Message, SendMessageInput, SendMessageResponse, GetMessagesInput, GetMessagesResponse } from './types.js';
import { scanForSecrets } from '../services/secret-scanner.js';
import { SecretDetectedError } from '../errors.js';

interface MessageRow {
  id: number;
  team_id: string;
  from_agent: string;
  to_agent: string;
  message: string;
  tags: string;
  created_at: string;
}

function rowToMessage(row: MessageRow): Message {
  return {
    id: row.id,
    teamId: row.team_id,
    fromAgent: row.from_agent,
    toAgent: row.to_agent,
    message: row.message,
    tags: JSON.parse(row.tags) as string[],
    createdAt: row.created_at,
  };
}

export function sendMessage(
  db: Database.Database,
  teamId: string,
  fromAgent: string,
  input: SendMessageInput,
): SendMessageResponse {
  // Scan message content for secrets
  const scan = scanForSecrets(input.message);
  if (!scan.clean) {
    throw new SecretDetectedError(scan.matches[0].pattern, scan.matches[0].preview);
  }

  const result = db.prepare(`
    INSERT INTO messages (team_id, from_agent, to_agent, message, tags)
    VALUES (?, ?, ?, ?, ?)
  `).run(teamId, fromAgent, input.to, input.message, JSON.stringify(input.tags));

  return { messageId: Number(result.lastInsertRowid) };
}

export function getMessages(
  db: Database.Database,
  teamId: string,
  agentId: string,
  input: GetMessagesInput,
): GetMessagesResponse {
  const limit = Math.min(input.limit ?? 50, 200);
  const sinceId = input.since_id ?? 0;

  const rows = db.prepare(`
    SELECT * FROM messages
    WHERE team_id = ? AND to_agent = ? AND id > ?
    ORDER BY id ASC
    LIMIT ?
  `).all(teamId, agentId, sinceId, limit) as MessageRow[];

  const messages = rows.map(rowToMessage);
  const cursor = messages.length > 0 ? messages[messages.length - 1].id : sinceId;

  return { messages, cursor };
}
