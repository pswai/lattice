import { useState, useMemo } from 'react';
import { Skeleton } from '../components/ui/Skeleton';
import { EmptyState, EMPTY_ICONS } from '../components/ui/EmptyState';
import { agentColor } from '../lib/utils';
import type { DashboardSnapshot, AuditEntry } from '../lib/types';

interface AuditTabProps {
  data: DashboardSnapshot | null;
  loading: boolean;
}

export default function AuditTab({ data, loading }: AuditTabProps) {
  const [actionFilter, setActionFilter] = useState('');

  const entries: AuditEntry[] = data?.auditLog ?? [];

  const actions = useMemo(
    () => [...new Set(entries.map((e) => e.action))].sort(),
    [entries],
  );

  const filtered = useMemo(
    () => (actionFilter ? entries.filter((e) => e.action === actionFilter) : entries),
    [entries, actionFilter],
  );

  if (loading && !data) {
    return (
      <div className="panel p-5">
        <Skeleton className="h-10 mb-2" />
        <Skeleton className="h-10 mb-2" />
        <Skeleton className="h-10 mb-2" />
        <Skeleton className="h-10" />
      </div>
    );
  }

  return (
    <div className="panel p-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Audit Log</h2>
          <p className="text-[11px] text-gray-600 mt-1">Every action performed in this workspace</p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
            className="bg-surface-0 border border-surface-3 rounded-lg px-2 py-1.5 text-xs text-gray-400 focus:outline-none focus:border-accent"
          >
            <option value="">All actions</option>
            {actions.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={EMPTY_ICONS.audit}
          title="No audit entries"
          description="Actions performed in this workspace will appear here."
        />
      ) : (
        <div className="scroll" style={{ maxHeight: '65vh' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Resource</th>
                <th>IP</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((e) => (
                <tr key={e.id}>
                  <td className="text-gray-500 text-[11px] whitespace-nowrap">
                    {new Date(e.createdAt).toLocaleString()}
                  </td>
                  <td>
                    <span
                      className="text-xs font-medium"
                      style={{ color: agentColor(e.actor || 'system') }}
                    >
                      {e.actor || 'system'}
                    </span>
                  </td>
                  <td>
                    <span className="text-xs font-mono text-gray-300">{e.action}</span>
                  </td>
                  <td className="text-xs text-gray-500">{e.resource || '--'}</td>
                  <td className="text-[11px] text-gray-600">{e.ip || 'local'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
