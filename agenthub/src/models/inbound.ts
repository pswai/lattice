import type { DbAdapter } from '../db/adapter.js';
import { randomBytes, createHmac, timingSafeEqual } from 'crypto';
import { NotFoundError, ValidationError } from '../errors.js';
import { throwIfSecretsFound } from '../services/secret-scanner.js';
import { createTask } from './task.js';
import { broadcastEvent } from './event.js';
import { saveContext } from './context.js';
import { runPlaybook } from './playbook.js';

export type InboundActionType =
  | 'create_task'
  | 'broadcast_event'
  | 'save_context'
  | 'run_playbook';

export interface InboundEndpoint {
  id: number;
  workspaceId: string;
  endpointKey: string;
  name: string;
  actionType: InboundActionType;
  actionConfig: Record<string, unknown>;
  hmacSecret: string | null;
  active: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

interface EndpointRow {
  id: number;
  workspace_id: string;
  endpoint_key: string;
  name: string;
  action_type: string;
  action_config: string;
  hmac_secret: string | null;
  active: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

function rowToEndpoint(row: EndpointRow): InboundEndpoint {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    endpointKey: row.endpoint_key,
    name: row.name,
    actionType: row.action_type as InboundActionType,
    actionConfig: JSON.parse(row.action_config) as Record<string, unknown>,
    hmacSecret: row.hmac_secret,
    active: row.active === 1,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const VALID_ACTION_TYPES: InboundActionType[] = [
  'create_task',
  'broadcast_event',
  'save_context',
  'run_playbook',
];

export interface DefineInboundEndpointInput {
  name: string;
  action_type: InboundActionType;
  action_config?: Record<string, unknown>;
  hmac_secret?: string;
}

export async function defineInboundEndpoint(
  db: DbAdapter,
  workspaceId: string,
  agentId: string,
  input: DefineInboundEndpointInput,
): Promise<InboundEndpoint> {
  if (!input.name || input.name.length === 0) {
    throw new ValidationError('name is required');
  }
  if (!VALID_ACTION_TYPES.includes(input.action_type)) {
    throw new ValidationError(
      `Invalid action_type '${input.action_type}'. Allowed: ${VALID_ACTION_TYPES.join(', ')}`,
    );
  }
  const config = input.action_config ?? {};
  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new ValidationError('action_config must be an object');
  }

  const endpointKey = randomBytes(16).toString('hex');

  const result = await db.run(
    `INSERT INTO inbound_endpoints (workspace_id, endpoint_key, name, action_type, action_config, hmac_secret, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    workspaceId,
    endpointKey,
    input.name,
    input.action_type,
    JSON.stringify(config),
    input.hmac_secret ?? null,
    agentId,
  );

  const row = await db.get<EndpointRow>(
    'SELECT * FROM inbound_endpoints WHERE id = ?',
    Number(result.lastInsertRowid),
  );
  return rowToEndpoint(row!);
}

export async function listInboundEndpoints(
  db: DbAdapter,
  workspaceId: string,
): Promise<{ endpoints: InboundEndpoint[]; total: number }> {
  const rows = await db.all<EndpointRow>(
    'SELECT * FROM inbound_endpoints WHERE workspace_id = ? ORDER BY created_at DESC',
    workspaceId,
  );
  const endpoints = rows.map(rowToEndpoint);
  return { endpoints, total: endpoints.length };
}

export async function getInboundEndpointByKey(
  db: DbAdapter,
  endpointKey: string,
): Promise<InboundEndpoint | null> {
  const row = await db.get<EndpointRow>(
    'SELECT * FROM inbound_endpoints WHERE endpoint_key = ?',
    endpointKey,
  );
  if (!row) return null;
  return rowToEndpoint(row);
}

export async function getInboundEndpoint(
  db: DbAdapter,
  workspaceId: string,
  id: number,
): Promise<InboundEndpoint> {
  const row = await db.get<EndpointRow>(
    'SELECT * FROM inbound_endpoints WHERE id = ? AND workspace_id = ?',
    id, workspaceId,
  );
  if (!row) throw new NotFoundError('InboundEndpoint', id);
  return rowToEndpoint(row);
}

export async function deleteInboundEndpoint(
  db: DbAdapter,
  workspaceId: string,
  id: number,
): Promise<{ deleted: boolean }> {
  const result = await db.run(
    'DELETE FROM inbound_endpoints WHERE id = ? AND workspace_id = ?',
    id, workspaceId,
  );
  if (result.changes === 0) throw new NotFoundError('InboundEndpoint', id);
  return { deleted: true };
}

/** Verify HMAC signature in format "sha256=<hex>" using timing-safe compare. */
export function verifyHmacSignature(
  secret: string,
  bodyRaw: string,
  signatureHeader: string | undefined,
): boolean {
  if (!signatureHeader) return false;
  const match = /^sha256=([a-f0-9]+)$/i.exec(signatureHeader.trim());
  if (!match) return false;
  const expected = createHmac('sha256', secret).update(bodyRaw).digest('hex');
  const provided = match[1].toLowerCase();
  if (provided.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(provided, 'hex'));
  } catch {
    return false;
  }
}

/** Simple {{path}} template substitution — looks up dotted paths in payload. */
function renderTemplate(template: string, payload: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => {
    const parts = path.split('.');
    let cur: unknown = payload;
    for (const p of parts) {
      if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
        cur = (cur as Record<string, unknown>)[p];
      } else {
        return '';
      }
    }
    if (cur === undefined || cur === null) return '';
    return typeof cur === 'string' ? cur : JSON.stringify(cur);
  });
}

export interface ProcessInboundResult {
  action: InboundActionType;
  [key: string]: unknown;
}

export async function processInboundWebhook(
  db: DbAdapter,
  endpoint: InboundEndpoint,
  payload: Record<string, unknown>,
): Promise<ProcessInboundResult> {
  // Scan payload content for leaked secrets before processing
  throwIfSecretsFound(JSON.stringify(payload));

  const agentId = `inbound:${endpoint.name}`;
  const cfg = endpoint.actionConfig;

  if (endpoint.actionType === 'create_task') {
    let description: string | undefined;
    if (typeof payload.description === 'string' && payload.description.length > 0) {
      description = payload.description;
    } else if (typeof cfg.description_template === 'string') {
      description = renderTemplate(cfg.description_template, payload);
    }
    if (!description || description.length === 0) {
      throw new ValidationError(
        'create_task requires payload.description or action_config.description_template',
      );
    }
    const priority = (typeof cfg.priority === 'string' ? cfg.priority : 'P2') as
      | 'P0'
      | 'P1'
      | 'P2'
      | 'P3';
    const assignedTo =
      typeof cfg.assigned_to === 'string' ? cfg.assigned_to : undefined;
    const result = await createTask(db, endpoint.workspaceId, agentId, {
      description,
      status: 'open',
      priority,
      assigned_to: assignedTo,
    });
    return { action: 'create_task', task_id: result.task_id };
  }

  if (endpoint.actionType === 'broadcast_event') {
    const eventType = (typeof cfg.event_type === 'string'
      ? cfg.event_type
      : 'BROADCAST') as
      | 'LEARNING'
      | 'BROADCAST'
      | 'ESCALATION'
      | 'ERROR'
      | 'TASK_UPDATE';
    const message =
      typeof payload.message === 'string' && payload.message.length > 0
        ? payload.message
        : JSON.stringify(payload);
    const tags = Array.isArray(cfg.tags)
      ? (cfg.tags as unknown[]).filter((t): t is string => typeof t === 'string')
      : ['inbound'];
    const result = await broadcastEvent(db, endpoint.workspaceId, agentId, {
      event_type: eventType,
      message,
      tags,
    });
    return { action: 'broadcast_event', event_id: result.eventId };
  }

  if (endpoint.actionType === 'save_context') {
    const key =
      typeof cfg.key === 'string' && cfg.key.length > 0
        ? renderTemplate(cfg.key, payload)
        : `inbound-${endpoint.name}-${Date.now()}`;
    const value =
      typeof payload.value === 'string' && payload.value.length > 0
        ? payload.value
        : JSON.stringify(payload);
    const tags = Array.isArray(cfg.tags)
      ? (cfg.tags as unknown[]).filter((t): t is string => typeof t === 'string')
      : ['inbound'];
    const result = await saveContext(db, endpoint.workspaceId, agentId, {
      key,
      value,
      tags,
    });
    return { action: 'save_context', context_id: result.id, key: result.key };
  }

  if (endpoint.actionType === 'run_playbook') {
    const playbookName = typeof cfg.playbook_name === 'string' ? cfg.playbook_name : '';
    if (!playbookName) {
      throw new ValidationError('run_playbook requires action_config.playbook_name');
    }
    let vars: Record<string, string> | undefined;
    if (Array.isArray(cfg.vars_from_payload)) {
      vars = {};
      for (const key of cfg.vars_from_payload) {
        if (typeof key !== 'string') continue;
        const value = payload[key];
        if (value === undefined || value === null) continue;
        vars[key] = typeof value === 'string' ? value : JSON.stringify(value);
      }
    }
    const result = await runPlaybook(db, endpoint.workspaceId, agentId, playbookName, vars);
    return {
      action: 'run_playbook',
      workflow_run_id: result.workflow_run_id,
      created_task_ids: result.created_task_ids,
    };
  }

  throw new ValidationError(`Unsupported action_type: ${endpoint.actionType}`);
}
