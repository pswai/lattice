import { clearApiKey } from '../../lib/api';
import type { SseStatus } from '../../lib/sse';
import type { TabId } from '../../lib/types';
import { cn } from '../../lib/utils';

const TABS: { id: TabId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'graph', label: 'Task Graph' },
  { id: 'artifacts', label: 'Artifacts' },
  { id: 'playbooks', label: 'Playbooks' },
];

const ADMIN_TABS: { id: TabId; label: string }[] = [
  { id: 'members', label: 'Members' },
  { id: 'audit', label: 'Audit Log' },
  { id: 'usage', label: 'Usage' },
  { id: 'keys', label: 'API Keys' },
];

const SSE_CLASSES: Record<SseStatus, string> = {
  connecting: 'conn-indicator conn-connecting',
  live: 'conn-indicator conn-live',
  error: 'conn-indicator conn-error',
};

interface HeaderProps {
  workspaceName?: string;
  sseStatus: SseStatus;
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
}

export function Header({ workspaceName, sseStatus, activeTab, onTabChange }: HeaderProps) {
  const handleLogout = () => {
    clearApiKey();
    window.location.reload();
  };

  return (
    <header className="border-b border-surface-3 px-4 md:px-6 py-3">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex items-center gap-2 shrink-0">
            <div className="w-7 h-7 rounded-lg bg-accent/20 flex items-center justify-center">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M8 1L14.93 5.5V10.5L8 15L1.07 10.5V5.5L8 1Z" stroke="#6366f1" strokeWidth="1.5" />
              </svg>
            </div>
            <span className="font-semibold text-sm hidden sm:inline">Lattice</span>
          </div>
          <div className="h-4 w-px bg-surface-3 hidden sm:block" />
          {workspaceName && (
            <div className="min-w-0 hidden sm:block">
              <div className="text-sm font-medium truncate text-gray-300">{workspaceName}</div>
            </div>
          )}
        </div>

        <div className="shrink-0">
          <div className={SSE_CLASSES[sseStatus]}>
            <span className="w-1.5 h-1.5 rounded-full bg-current" />
            <span>{sseStatus === 'live' ? 'live' : sseStatus}</span>
          </div>
        </div>

        <button onClick={handleLogout} className="btn-ghost text-xs shrink-0">
          Sign out
        </button>
      </div>

      <nav className="flex gap-1 mt-3 tab-scroll -mb-px">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            className={cn('tab-btn', activeTab === tab.id && 'active')}
            onClick={() => onTabChange(tab.id)}
          >
            {tab.label}
          </button>
        ))}
        <div className="w-px bg-surface-3 mx-1 self-stretch hidden sm:block" />
        {ADMIN_TABS.map((tab) => (
          <button
            key={tab.id}
            className={cn('tab-btn', activeTab === tab.id && 'active')}
            onClick={() => onTabChange(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </nav>
    </header>
  );
}
