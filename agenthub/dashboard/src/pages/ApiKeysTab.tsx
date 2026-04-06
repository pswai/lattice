import { Skeleton } from '../components/ui/Skeleton';
import { EmptyState, EMPTY_ICONS } from '../components/ui/EmptyState';
import { ScopeBadge } from '../components/ui/Badge';
import { timeAgo } from '../lib/utils';
import type { DashboardSnapshot, ApiKey } from '../lib/types';

interface ApiKeysTabProps {
  data: DashboardSnapshot | null;
  loading: boolean;
}

function StatusBadge({ apiKey }: { apiKey: ApiKey }) {
  const isRevoked = !!apiKey.revokedAt;
  const isExpired = apiKey.expiresAt ? new Date(apiKey.expiresAt) < new Date() : false;

  if (isRevoked) {
    return (
      <span className="badge" style={{ background: 'rgba(239,68,68,0.1)', color: '#fca5a5', border: '1px solid rgba(239,68,68,0.2)' }}>
        revoked
      </span>
    );
  }
  if (isExpired) {
    return (
      <span className="badge" style={{ background: 'rgba(234,179,8,0.1)', color: '#fde047', border: '1px solid rgba(234,179,8,0.2)' }}>
        expired
      </span>
    );
  }
  return (
    <span className="badge" style={{ background: 'rgba(34,197,94,0.1)', color: '#86efac', border: '1px solid rgba(34,197,94,0.2)' }}>
      active
    </span>
  );
}

export default function ApiKeysTab({ data, loading }: ApiKeysTabProps) {
  if (loading && !data) {
    return (
      <div className="panel p-5">
        <Skeleton className="h-10 mb-2" />
        <Skeleton className="h-10 mb-2" />
        <Skeleton className="h-10" />
      </div>
    );
  }

  const keys = data?.apiKeys ?? [];
  const activeKeys = keys.filter((k) => !k.revokedAt);

  return (
    <div className="panel p-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">API Keys</h2>
          <p className="text-[11px] text-gray-600 mt-1">
            Manage workspace API keys &middot; Create and revoke keys via the admin API
          </p>
        </div>
        <span className="text-[10px] text-gray-600">
          {activeKeys.length} active, {keys.length} total
        </span>
      </div>

      {keys.length === 0 ? (
        <EmptyState
          icon={EMPTY_ICONS.keys}
          title="No API keys"
          description="Create an API key to allow agents to connect to this workspace."
        />
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Label</th>
              <th>Scope</th>
              <th>Created</th>
              <th>Last Used</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => {
              const isRevoked = !!k.revokedAt;
              return (
                <tr key={k.id} style={isRevoked ? { opacity: 0.5 } : undefined}>
                  <td className="text-xs font-mono text-gray-400">{k.id}</td>
                  <td className="text-xs text-gray-300">{k.label || '--'}</td>
                  <td><ScopeBadge scope={k.scope} /></td>
                  <td className="text-[11px] text-gray-500">
                    {k.createdAt ? timeAgo(k.createdAt) : '--'}
                  </td>
                  <td className="text-[11px] text-gray-500">
                    {k.lastUsedAt ? timeAgo(k.lastUsedAt) : 'never'}
                  </td>
                  <td><StatusBadge apiKey={k} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
