import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DbAdapter } from '../../db/adapter.js';
import type { ToolDefinition, ToolTier } from './types.js';
import { AppError } from '../../errors.js';
import { getMcpAuth, requireWriteScope } from '../auth-context.js';
import { autoRegisterAgent } from '../../models/agent.js';
import { throwIfSecretsFound } from '../../services/secret-scanner.js';
import { writeAudit } from '../../models/audit.js';
import { getLogger } from '../../logger.js';

// ─── Audit map ──────────────────────────────────────────────────
const TOOL_AUDIT_MAP: Record<string, { resource: string; verb: string }> = {
  save_context: { resource: 'context', verb: 'create' },
  broadcast: { resource: 'event', verb: 'create' },
  create_task: { resource: 'task', verb: 'create' },
  update_task: { resource: 'task', verb: 'update' },
  register_agent: { resource: 'agent', verb: 'create' },
  send_message: { resource: 'message', verb: 'create' },
  define_playbook: { resource: 'playbook', verb: 'create' },
  run_playbook: { resource: 'workflow_run', verb: 'create' },
  define_schedule: { resource: 'schedule', verb: 'create' },
  delete_schedule: { resource: 'schedule', verb: 'delete' },
  save_artifact: { resource: 'artifact', verb: 'create' },
  define_profile: { resource: 'profile', verb: 'create' },
  delete_profile: { resource: 'profile', verb: 'delete' },
  define_inbound_endpoint: { resource: 'inbound_endpoint', verb: 'create' },
  delete_inbound_endpoint: { resource: 'inbound_endpoint', verb: 'delete' },
};

function errorResult(err: AppError) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(err.toJSON()) }],
    isError: true,
  };
}

async function mcpAudit(db: DbAdapter, toolName: string, agentId: string): Promise<void> {
  try {
    const auth = getMcpAuth();
    const mapping = TOOL_AUDIT_MAP[toolName];
    const action = mapping ? `${mapping.resource}.${mapping.verb}` : toolName;
    await writeAudit(db, {
      workspaceId: auth.workspaceId,
      actor: agentId,
      action,
      resourceType: mapping?.resource ?? null,
      resourceId: null,
      metadata: { source: 'mcp', tool: toolName },
      ip: auth.ip ?? null,
      requestId: auth.requestId ?? null,
    });
  } catch (err) {
    try {
      getLogger().error('mcp_audit_write_failed', {
        component: 'audit',
        tool: toolName,
        error: err instanceof Error ? err.message : String(err),
      });
    } catch { /* swallow logger failures */ }
  }
}

// ─── Tier filtering ─────────────────────────────────────────────
export function parseEnabledTiers(latticeTools: string): Set<ToolTier> | 'all' {
  const val = latticeTools.trim().toLowerCase();
  if (val === 'all' || val === '') return 'all';
  const tiers = val.split(',').map(s => s.trim()).filter(s => s.length > 0);
  return new Set(tiers as ToolTier[]);
}

// ─── Registration loop ─────────────────────────────────────────
export function registerTools(
  server: McpServer,
  db: DbAdapter,
  tools: ToolDefinition[],
  enabledTiers: Set<ToolTier> | 'all',
): void {
  for (const tool of tools) {
    if (enabledTiers !== 'all' && !enabledTiers.has(tool.tier)) continue;

    server.tool(tool.name, tool.description, tool.schema, async (params) => {
      const { workspaceId, agentId: headerAgentId } = getMcpAuth();
      if (tool.write) requireWriteScope();

      const agentId = (params as Record<string, unknown>).agent_id as string || headerAgentId;
      if (tool.autoRegister) await autoRegisterAgent(db, workspaceId, agentId);

      try {
        if (tool.secretScan) {
          for (const field of tool.secretScan) {
            const val = (params as Record<string, unknown>)[field];
            if (typeof val === 'string') {
              throwIfSecretsFound(val);
            } else if (val && typeof val === 'object') {
              for (const v of Object.values(val as Record<string, unknown>)) {
                if (typeof v === 'string') throwIfSecretsFound(v);
              }
            }
          }
        }

        const result = await tool.handler({ db, workspaceId, agentId }, params as Record<string, unknown>);

        if (TOOL_AUDIT_MAP[tool.name]) {
          await mcpAudit(db, tool.name, agentId);
        }

        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (err) {
        if (err instanceof AppError) return errorResult(err);
        throw err;
      }
    });
  }
}
