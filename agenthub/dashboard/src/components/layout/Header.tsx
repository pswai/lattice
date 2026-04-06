import { NavLink } from 'react-router-dom';
import { clearApiKey } from '../../lib/api';
import type { SseStatus } from '../../lib/sse';

const TABS = [
  { to: '/', label: 'Overview' },
  { to: '/graph', label: 'Task Graph' },
  { to: '/artifacts', label: 'Artifacts' },
  { to: '/playbooks', label: 'Playbooks' },
];

const ADMIN_TABS = [
  { to: '/members', label: 'Members' },
  { to: '/audit', label: 'Audit Log' },
  { to: '/usage', label: 'Usage' },
  { to: '/keys', label: 'API Keys' },
];

const SSE_CLASSES: Record<SseStatus, string> = {
  connecting: 'conn-indicator conn-connecting',
  live: 'conn-indicator conn-live',
  error: 'conn-indicator conn-error',
};

interface HeaderProps {
  workspaceName?: string;
  sseStatus: SseStatus;
}

export function Header({ workspaceName, sseStatus }: HeaderProps) {
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
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.to === '/'}
            className={({ isActive }) => `tab-btn${isActive ? ' active' : ''}`}
          >
            {tab.label}
          </NavLink>
        ))}
        <div className="w-px bg-surface-3 mx-1 self-stretch hidden sm:block" />
        {ADMIN_TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            className={({ isActive }) => `tab-btn${isActive ? ' active' : ''}`}
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>
    </header>
  );
}
