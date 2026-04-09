import { lazy, Suspense, useMemo } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AuthGate } from './components/layout/AuthGate';
import { Header } from './components/layout/Header';
import { ToastContainer } from './components/ui/Toast';
import { Skeleton } from './components/ui/Skeleton';
import { useSSE } from './hooks/useSSE';
import { useDashboard } from './hooks/useDashboard';
import { getApiKey } from './lib/api';

const OverviewTab = lazy(() => import('./pages/OverviewTab'));
const GraphTab = lazy(() => import('./pages/GraphTab'));
const ArtifactsTab = lazy(() => import('./pages/ArtifactsTab'));
const PlaybooksTab = lazy(() => import('./pages/PlaybooksTab'));
const AuditTab = lazy(() => import('./pages/AuditTab'));
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

/** Map the current route to the snapshot sections needed by that tab. */
function useSectionsForRoute(): string[] | undefined {
  const { pathname } = useLocation();
  return useMemo(() => {
    // Strip leading slashes and trailing segments
    const segment = pathname.replace(/^\/+/, '').split('/')[0] || '';
    switch (segment) {
      case '':        return ['agents', 'tasks', 'events', 'analytics']; // Overview
      case 'audit':   return ['auditLog'];
      case 'keys':    return ['apiKeys'];
      // Graph, Artifacts, Playbooks fetch their own data — no snapshot needed
      case 'graph':
      case 'artifacts':
      case 'playbooks':
        return [];
      default:        return undefined; // all sections
    }
  }, [pathname]);
}

function Dashboard() {
  const sections = useSectionsForRoute();
  const { data, loading, refresh } = useDashboard(sections);
  const { status: sseStatus, events: sseEvents } = useSSE({
    token: getApiKey(),
    onTaskUpdate: refresh,
  });

  return (
    <>
      <Header workspaceName={data?.workspace?.name} sseStatus={sseStatus} />
      <main className="p-4 md:p-6 max-w-[1600px] mx-auto">
        <Suspense fallback={<TabFallback />}>
          <Routes>
            <Route index element={<OverviewTab data={data} loading={loading} sseEvents={sseEvents} sseStatus={sseStatus} />} />
            <Route path="graph" element={<GraphTab />} />
            <Route path="artifacts" element={<ArtifactsTab />} />
            <Route path="playbooks" element={<PlaybooksTab />} />
            <Route path="audit" element={<AuditTab data={data} loading={loading} />} />
            <Route path="keys" element={<ApiKeysTab data={data} loading={loading} />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </main>
      <ToastContainer />
    </>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthGate>
        <Dashboard />
      </AuthGate>
    </BrowserRouter>
  );
}
