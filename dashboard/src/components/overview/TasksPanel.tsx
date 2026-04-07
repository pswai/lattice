import type { Task } from '../../lib/types';
import { agentColor, timeAgo } from '../../lib/utils';
import { Badge } from '../ui/Badge';

interface TasksPanelProps {
  tasks: Task[];
}

function TaskCard({ t }: { t: Task }) {
  const p = t.priority || 'P2';
  const who = t.claimedBy || t.assignedTo || '--';
  const age = timeAgo(t.createdAt);

  return (
    <div className="panel p-3 text-xs">
      <div className="flex items-center gap-2 mb-1.5">
        <Badge variant={p}>{p}</Badge>
        <span className="text-[10px] text-gray-600">#{t.id}</span>
        <span className="text-[10px] text-gray-600 ml-auto">{age}</span>
      </div>
      <div
        className="text-gray-300 leading-snug mb-1"
        style={{
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}
      >
        {(t.description || '').slice(0, 200)}
      </div>
      <div className="text-[10px] text-gray-500">
        <span style={{ color: agentColor(who) }}>{who}</span>
      </div>
    </div>
  );
}

const COLUMNS = [
  { key: 'open' as const, label: 'Open', dotClass: 'w-2 h-2 rounded-full bg-gray-500' },
  { key: 'claimed' as const, label: 'Claimed', dotClass: 'w-2 h-2 rounded-sm bg-yellow-500 rotate-45' },
  { key: 'completed' as const, label: 'Completed', dotClass: 'w-2 h-2 rounded-full bg-green-500' },
];

export function TasksPanel({ tasks }: TasksPanelProps) {
  const cols: Record<string, Task[]> = { open: [], claimed: [], completed: [] };
  for (const t of tasks) {
    if (cols[t.status]) cols[t.status].push(t);
  }

  return (
    <div className="panel p-5">
      <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4">Tasks</h2>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {COLUMNS.map((col) => (
          <div key={col.key}>
            <div className="flex items-center gap-2 mb-2">
              <span className={col.dotClass} />
              <span className="text-xs text-gray-500 font-medium">{col.label}</span>
              <span className="text-[10px] text-gray-600 ml-auto">{cols[col.key].length}</span>
            </div>
            <div className="space-y-2 scroll" style={{ maxHeight: '32vh' }}>
              {cols[col.key].length === 0 ? (
                <div className="text-[11px] text-gray-600 py-4 text-center">None</div>
              ) : (
                cols[col.key].map((t) => <TaskCard key={t.id} t={t} />)
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
