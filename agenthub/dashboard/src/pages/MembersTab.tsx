import { Skeleton } from '../components/ui/Skeleton';
import { EmptyState, EMPTY_ICONS } from '../components/ui/EmptyState';
import { RoleBadge } from '../components/ui/Badge';
import { agentColor, timeAgo } from '../lib/utils';
import type { DashboardSnapshot } from '../lib/types';

interface MembersTabProps {
  data: DashboardSnapshot | null;
  loading: boolean;
}

export default function MembersTab({ data, loading }: MembersTabProps) {
  if (loading && !data) {
    return (
      <div className="panel p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Workspace Members</h2>
        </div>
        <Skeleton className="h-10 mb-2" />
        <Skeleton className="h-10 mb-2" />
        <Skeleton className="h-10" />
      </div>
    );
  }

  const members = data?.members ?? [];

  return (
    <div className="panel p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Workspace Members</h2>
        <span className="text-[10px] text-gray-600">
          {members.length} member{members.length !== 1 ? 's' : ''}
        </span>
      </div>

      {members.length === 0 ? (
        <EmptyState
          icon={EMPTY_ICONS.members}
          title="No members found"
          description="Members are added via workspace invitations or OAuth sign-up."
        />
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>User</th>
              <th>Role</th>
              <th>Joined</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => {
              const display = m.name || m.email || m.userId;
              const sub = m.email && m.name ? m.email : m.userId;
              const color = agentColor(display);

              return (
                <tr key={m.userId}>
                  <td>
                    <div className="flex items-center gap-2">
                      <div
                        className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-semibold"
                        style={{ background: color + '30', color }}
                      >
                        {display.charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <div className="text-sm font-medium text-gray-200">{display}</div>
                        <div className="text-[11px] text-gray-500">{sub}</div>
                      </div>
                    </div>
                  </td>
                  <td><RoleBadge role={m.role} /></td>
                  <td className="text-gray-500 text-xs">
                    {m.joinedAt ? timeAgo(m.joinedAt) : '--'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
