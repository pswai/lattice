import type { LatticeEvent } from '../../lib/types';
import { agentColor } from '../../lib/utils';
import { Skeleton } from '../ui/Skeleton';
import { EmptyState, EMPTY_ICONS } from '../ui/EmptyState';

interface EventFeedProps {
  events: LatticeEvent[];
  loading?: boolean;
}

export function EventFeed({ events, loading }: EventFeedProps) {
  return (
    <div className="panel p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Event Feed</h2>
        <span className="text-[10px] text-gray-600">live</span>
      </div>
      <div className="scroll" style={{ maxHeight: '35vh' }}>
        {loading && events.length === 0 ? (
          <div className="space-y-2">
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        ) : events.length === 0 ? (
          <EmptyState
            icon={EMPTY_ICONS.events}
            title="No events yet"
            description="Events appear here as agents broadcast updates, complete tasks, or share learnings."
          />
        ) : (
          events.map((ev) => {
            const time = new Date(ev.createdAt).toLocaleTimeString();
            const agent = ev.createdBy || 'unknown';

            return (
              <div key={ev.id} className={`ev ev-${ev.eventType || 'BROADCAST'}`}>
                <div className="flex justify-between text-[10px] text-gray-500">
                  <span style={{ color: agentColor(agent) }}>{agent}</span>
                  <span>
                    {time} &middot; <span className="font-medium">{ev.eventType || ''}</span>
                  </span>
                </div>
                <div className="mt-1 text-gray-300 leading-snug">
                  {(ev.message || '').slice(0, 300)}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
