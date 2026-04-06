import type { SseStatus } from '../../lib/sse';
import type { Agent } from '../../lib/types';
import { getApiCallCount } from '../../lib/api';

interface SystemBarProps {
  sseStatus: SseStatus;
  agents: Agent[];
  lastRefreshTime: string | null;
}

const SSE_LABEL: Record<SseStatus, { text: string; className: string }> = {
  live: { text: 'connected', className: 'font-medium text-green-400' },
  connecting: { text: 'reconnecting...', className: 'font-medium text-yellow-400' },
  error: { text: 'disconnected', className: 'font-medium text-red-400' },
};

export function SystemBar({ sseStatus, agents, lastRefreshTime }: SystemBarProps) {
  const onlineCount = agents.filter((a) => a.status === 'online').length;

  return (
    <div className="flex flex-wrap items-center gap-3 mb-4 text-[11px]">
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-surface-1 border border-surface-3">
        <span className="text-gray-500">SSE</span>
        <span className={SSE_LABEL[sseStatus].className}>{SSE_LABEL[sseStatus].text}</span>
      </div>
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-surface-1 border border-surface-3">
        <span className="text-gray-500">Agents</span>
        <span className="font-medium text-gray-400">{onlineCount}/{agents.length}</span>
      </div>
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-surface-1 border border-surface-3">
        <span className="text-gray-500">Task Reaper</span>
        <span className="font-medium text-green-400">active</span>
        <span className="text-gray-600 cursor-help" title="Idle tasks without heartbeat are abandoned after 30m">
          &#9432;
        </span>
      </div>
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-surface-1 border border-surface-3">
        <span className="text-gray-500">Rate Limit</span>
        <span className="font-medium text-green-400">ok ({getApiCallCount()} calls)</span>
      </div>
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-surface-1 border border-surface-3">
        <span className="text-gray-500">Last refresh</span>
        <span className="font-medium text-gray-400">{lastRefreshTime || '--'}</span>
      </div>
    </div>
  );
}
