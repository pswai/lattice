import type { Agent } from '../../lib/types';
import { agentColor, timeAgo } from '../../lib/utils';
import { EmptyState, EMPTY_ICONS } from '../ui/EmptyState';

interface AgentsPanelProps {
  agents: Agent[];
}

export function AgentsPanel({ agents }: AgentsPanelProps) {
  return (
    <section className="panel p-5 lg:col-span-3">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Agents</h2>
        <span className="text-[10px] text-gray-600">{agents.length}</span>
      </div>
      <div className="space-y-2 scroll" style={{ maxHeight: '70vh' }}>
        {agents.length === 0 ? (
          <EmptyState
            icon={EMPTY_ICONS.agents}
            title="No agents registered"
            description="Agents auto-register on first MCP call. Connect an agent to see it here."
          />
        ) : (
          agents.map((a) => {
            const st = a.status || 'offline';
            const caps = (a.capabilities || []).slice(0, 3).join(', ');
            const hb = a.lastHeartbeat ? timeAgo(a.lastHeartbeat) : 'never';

            return (
              <div
                key={a.id}
                className={`flex items-start gap-2 p-2 rounded-lg hover:bg-surface-0 transition-colors status-${st}`}
              >
                <span className="status-dot mt-1" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate" style={{ color: agentColor(a.id) }}>
                    {a.id}
                  </div>
                  {caps && (
                    <div className="text-[11px] text-gray-500 truncate mt-0.5">{caps}</div>
                  )}
                  <div className="text-[10px] text-gray-600 mt-0.5">heartbeat: {hb}</div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
