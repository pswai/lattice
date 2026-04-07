import { useMemo } from 'react';
import type { DashboardSnapshot, LatticeEvent } from '../lib/types';
import type { SseStatus } from '../lib/sse';
import { AgentsPanel } from '../components/overview/AgentsPanel';
import { TasksPanel } from '../components/overview/TasksPanel';
import { EventFeed } from '../components/overview/EventFeed';
import { AnalyticsPanel } from '../components/overview/AnalyticsPanel';
import { SystemBar } from '../components/overview/SystemBar';

interface OverviewTabProps {
  data: DashboardSnapshot | null;
  loading: boolean;
  sseEvents: LatticeEvent[];
  sseStatus?: SseStatus;
}

function OverviewTab({ data, loading, sseEvents, sseStatus = 'connecting' }: OverviewTabProps) {
  const agents = data?.agents ?? [];
  const tasks = data?.tasks ?? [];
  const analytics = data?.analytics ?? null;

  const lastRefreshTime = useMemo(() => {
    return data ? new Date().toLocaleTimeString() : null;
  }, [data]);

  return (
    <>
      <SystemBar sseStatus={sseStatus} agents={agents} lastRefreshTime={lastRefreshTime} />
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <AgentsPanel agents={agents} />
        <section className="lg:col-span-6 space-y-4">
          <TasksPanel tasks={tasks} />
          <EventFeed events={sseEvents} loading={loading} />
        </section>
        <AnalyticsPanel analytics={analytics} agents={agents} loading={loading} />
      </div>
    </>
  );
}

export default OverviewTab;
