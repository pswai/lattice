import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
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
  const { data, loading, refresh } = useDashboard();
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
            <Route path="members" element={<MembersTab data={data} loading={loading} />} />
            <Route path="audit" element={<AuditTab data={data} loading={loading} />} />
            <Route path="usage" element={<UsageTab data={data} loading={loading} />} />
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
