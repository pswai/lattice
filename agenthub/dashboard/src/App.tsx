import { useState, useCallback, useEffect, lazy, Suspense } from 'react';
import { AuthGate } from './components/layout/AuthGate';
import { Header } from './components/layout/Header';
import { ToastContainer } from './components/ui/Toast';
import { Skeleton } from './components/ui/Skeleton';
import { useSSE } from './hooks/useSSE';
import { useDashboard } from './hooks/useDashboard';
import { getApiKey } from './lib/api';
import type { TabId } from './lib/types';

const VALID_TABS = new Set<TabId>(['overview', 'graph', 'artifacts', 'playbooks', 'members', 'audit', 'usage', 'keys']);

function getTabFromHash(): TabId {
  const hash = location.hash.replace('#', '');
  return VALID_TABS.has(hash as TabId) ? (hash as TabId) : 'overview';
}

const OverviewTab = lazy(() => import('./pages/OverviewTab'));
const GraphTab = lazy(() => import('./pages/GraphTab'));
const ArtifactsTab = lazy(() => import('./pages/ArtifactsTab'));
const PlaybooksTab = lazy(() => import('./pages/PlaybooksTab'));
const MembersTab = lazy(() => import('./pages/MembersTab'));
const AuditTab = lazy(() => import('./pages/AuditTab'));
const UsageTab = lazy(() => import('./pages/UsageTab'));
const ApiKeysTab = lazy(() => import('./pages/ApiKeysTab'));

function TabFallback() {
  return (
    <div className="space-y-4 p-6">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-32" />
      <Skeleton className="h-32" />
    </div>
  );
}

function Dashboard() {
  const [activeTab, setActiveTab] = useState<TabId>(getTabFromHash);
  const [activatedTabs, setActivatedTabs] = useState<Set<TabId>>(() => new Set([getTabFromHash()]));

  const { data, loading, refresh } = useDashboard();

  const handleTabChange = useCallback((tab: TabId) => {
    location.hash = tab === 'overview' ? '' : tab;
    setActiveTab(tab);
    setActivatedTabs((prev) => {
      if (prev.has(tab)) return prev;
      const next = new Set(prev);
      next.add(tab);
      return next;
    });
  }, []);

  // Sync tab state with browser back/forward navigation
  useEffect(() => {
    const onHashChange = () => {
      const tab = getTabFromHash();
      setActiveTab(tab);
      setActivatedTabs((prev) => {
        if (prev.has(tab)) return prev;
        const next = new Set(prev);
        next.add(tab);
        return next;
      });
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const { status: sseStatus, events: sseEvents } = useSSE({
    token: getApiKey(),
    onTaskUpdate: refresh,
  });

  const renderTab = (tab: TabId) => {
    if (!activatedTabs.has(tab)) return null;
    const hidden = activeTab !== tab;
    const style = hidden ? { display: 'none' } : undefined;

    return (
      <div key={tab} style={style} className={hidden ? undefined : 'animate-fade-in'}>
        <Suspense fallback={<TabFallback />}>
          {tab === 'overview' && <OverviewTab data={data} loading={loading} sseEvents={sseEvents} sseStatus={sseStatus} />}
          {tab === 'graph' && <GraphTab />}
          {tab === 'artifacts' && <ArtifactsTab />}
          {tab === 'playbooks' && <PlaybooksTab />}
          {tab === 'members' && <MembersTab data={data} loading={loading} />}
          {tab === 'audit' && <AuditTab data={data} loading={loading} />}
          {tab === 'usage' && <UsageTab data={data} loading={loading} />}
          {tab === 'keys' && <ApiKeysTab data={data} loading={loading} />}
        </Suspense>
      </div>
    );
  };

  return (
    <>
      <Header
        workspaceName={data?.workspace?.name}
        sseStatus={sseStatus}
        activeTab={activeTab}
        onTabChange={handleTabChange}
      />
      <main className="p-4 md:p-6 max-w-[1600px] mx-auto">
        {(['overview', 'graph', 'artifacts', 'playbooks', 'members', 'audit', 'usage', 'keys'] as TabId[]).map(renderTab)}
      </main>
      <ToastContainer />
    </>
  );
}

export default function App() {
  return (
    <AuthGate>
      <Dashboard />
    </AuthGate>
  );
}
