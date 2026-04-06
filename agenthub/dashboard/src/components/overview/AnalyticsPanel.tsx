import type { Analytics, Agent } from '../../lib/types';
import { agentColor } from '../../lib/utils';
import { Skeleton } from '../ui/Skeleton';

interface AnalyticsPanelProps {
  analytics: Analytics | null;
  agents: Agent[];
  loading?: boolean;
}

function StatCard({ label, value, loading }: { label: string; value: string; loading?: boolean }) {
  return (
    <div className="panel stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value text-gray-200">
        {loading ? <Skeleton className="h-8 w-16" /> : value}
      </div>
    </div>
  );
}

export function AnalyticsPanel({ analytics, agents, loading }: AnalyticsPanelProps) {
  const tasks = analytics?.tasks;
  const events = analytics?.events;
  const agentStats = analytics?.agents;
  const total = tasks?.total ?? 0;
  const rate = total > 0 ? Math.round((tasks?.completion_rate ?? 0) * 100) + '%' : '0%';

  return (
    <section className="lg:col-span-3 space-y-3">
      <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
        Analytics <span className="text-gray-600 font-normal">(24h)</span>
      </h2>
      <StatCard label="Tasks" value={String(total)} loading={loading} />
      <StatCard label="Events" value={String(events?.total ?? 0)} loading={loading} />
      <StatCard label="Agents" value={String(agentStats?.total ?? 0)} loading={loading} />
      <StatCard label="Completion Rate" value={rate} loading={loading} />

      <div className="panel p-4">
        <h3 className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-3">
          Agent Heartbeats
        </h3>
        <div className="space-y-2">
          {loading ? (
            <>
              <Skeleton className="h-4" />
              <Skeleton className="h-4" />
            </>
          ) : agents.length === 0 ? (
            <div className="text-[11px] text-gray-600 text-center py-2">No agents</div>
          ) : (
            agents.slice(0, 8).map((a) => {
              const now = Date.now();
              const hbTime = a.lastHeartbeat ? new Date(a.lastHeartbeat).getTime() : 0;
              const ago = hbTime ? Math.floor((now - hbTime) / 1000) : Infinity;

              let barColor = '#22c55e';
              let barWidth = 100;
              if (ago === Infinity) { barColor = '#3a3a4a'; barWidth = 5; }
              else if (ago > 1800) { barColor = '#ef4444'; barWidth = 10; }
              else if (ago > 300) { barColor = '#f59e0b'; barWidth = Math.max(20, 100 - (ago / 18)); }
              else { barWidth = Math.max(40, 100 - (ago / 3)); }

              const agoText = ago === Infinity ? '--' : ago < 60 ? ago + 's' : Math.floor(ago / 60) + 'm';

              return (
                <div key={a.id} className="flex items-center gap-2">
                  <span
                    className="text-[10px] w-16 truncate"
                    style={{ color: agentColor(a.id) }}
                  >
                    {a.id.slice(0, 10)}
                  </span>
                  <div className="flex-1 progress-bar">
                    <div
                      className="progress-fill"
                      style={{ width: `${barWidth}%`, background: barColor }}
                    />
                  </div>
                  <span className="text-[10px] text-gray-600 w-10 text-right">{agoText}</span>
                </div>
              );
            })
          )}
        </div>
      </div>
    </section>
  );
}
