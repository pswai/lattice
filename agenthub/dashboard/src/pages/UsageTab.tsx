import { Skeleton } from '../components/ui/Skeleton';
import { EmptyState, EMPTY_ICONS } from '../components/ui/EmptyState';
import { humanSize } from '../lib/utils';
import type { DashboardSnapshot } from '../lib/types';

interface UsageTabProps {
  data: DashboardSnapshot | null;
  loading: boolean;
}

function UsageCard({ label, used, quota, unit }: { label: string; used: number; quota: number; unit: 'count' | 'bytes' }) {
  const pct = quota > 0 ? Math.min(100, Math.round((used / quota) * 100)) : 0;
  let color = '#22c55e';
  if (pct > 90) color = '#ef4444';
  else if (pct > 70) color = '#f59e0b';

  const usedStr = unit === 'bytes' ? humanSize(used) : used.toLocaleString();
  const quotaStr = unit === 'bytes' ? humanSize(quota) : quota.toLocaleString();

  return (
    <div className="panel p-5">
      <div className="text-xs font-medium text-gray-400 mb-3">{label}</div>
      <div className="text-2xl font-bold text-gray-200 mb-1">{usedStr}</div>
      <div className="text-[11px] text-gray-500 mb-3">
        of {quotaStr} ({pct}%)
      </div>
      <div className="progress-bar">
        <div className="progress-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
      {pct > 90 && (
        <div className="text-[11px] text-red-400 mt-2 flex items-center gap-1">
          <span>&#9888;</span> Approaching limit
        </div>
      )}
    </div>
  );
}

export default function UsageTab({ data, loading }: UsageTabProps) {
  if (loading && !data) {
    return (
      <div className="panel p-5">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Usage &amp; Quotas</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
      </div>
    );
  }

  const usage = data?.usage;
  const limits = data?.limits;

  if (!usage || !limits) {
    return (
      <div className="panel p-5">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Usage &amp; Quotas</h2>
        </div>
        <EmptyState
          icon={EMPTY_ICONS.tasks}
          title="Usage data unavailable"
          description="Usage tracking may not be configured for this workspace."
        />
      </div>
    );
  }

  return (
    <div className="panel p-5">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Usage &amp; Quotas</h2>
          <p className="text-[11px] text-gray-600 mt-1">
            Plan: {limits.plan_name || 'Free'} &mdash; Current billing period
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <UsageCard label="Executions" used={usage.exec_count} quota={limits.exec_quota} unit="count" />
        <UsageCard label="API Calls" used={usage.api_call_count} quota={limits.api_call_quota} unit="count" />
        <UsageCard label="Storage" used={usage.storage_bytes} quota={limits.storage_bytes_quota} unit="bytes" />
        {data?.members && (
          <UsageCard label="Seats" used={data.members.length} quota={limits.seat_quota} unit="count" />
        )}
      </div>
    </div>
  );
}
