// Self-contained HTML+CSS+JS dashboard for Lattice.
// Served at GET / by the Hono app. No build step, no external deps beyond CDN Tailwind.
export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Lattice Dashboard</title>
<script src="https://cdn.tailwindcss.com"></script>
<script>
tailwind.config = {
  theme: {
    extend: {
      colors: {
        surface: { 0: '#0a0a0f', 1: '#12121a', 2: '#1a1a24', 3: '#22222e', 4: '#2a2a38' },
        accent: { DEFAULT: '#6366f1', light: '#818cf8', dim: '#4f46e5' },
        success: '#22c55e',
        warn: '#f59e0b',
        danger: '#ef4444',
        info: '#3b82f6',
      },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
    },
  },
}
</script>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
<style>
  * { box-sizing: border-box; }
  body { background: #0a0a0f; color: #e2e2ea; font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; }

  /* Scrollbars */
  .scroll { overflow-y: auto; }
  .scroll::-webkit-scrollbar { width: 5px; }
  .scroll::-webkit-scrollbar-track { background: transparent; }
  .scroll::-webkit-scrollbar-thumb { background: #2a2a38; border-radius: 3px; }
  .scroll::-webkit-scrollbar-thumb:hover { background: #3a3a4a; }

  /* Panel */
  .panel {
    background: #12121a;
    border: 1px solid #22222e;
    border-radius: 12px;
    transition: border-color 0.2s ease;
  }
  .panel:hover { border-color: #2a2a38; }

  /* Status indicators: color + shape for color-blind friendliness */
  .status-dot { display: inline-flex; align-items: center; justify-content: center; width: 10px; height: 10px; margin-right: 6px; flex-shrink: 0; }
  .status-online .status-dot { background: #22c55e; border-radius: 50%; }
  .status-busy .status-dot { background: #f59e0b; border-radius: 2px; transform: rotate(45deg); }
  .status-offline .status-dot { background: #4b5563; border-radius: 50%; border: 2px solid #4b5563; background: transparent; }

  /* Priority badges */
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 10px; font-weight: 600; letter-spacing: 0.5px; text-transform: uppercase; }
  .badge-P0 { background: rgba(220,38,38,0.15); color: #fca5a5; border: 1px solid rgba(220,38,38,0.3); }
  .badge-P1 { background: rgba(234,88,12,0.15); color: #fdba74; border: 1px solid rgba(234,88,12,0.3); }
  .badge-P2 { background: rgba(100,100,120,0.15); color: #a5a5b5; border: 1px solid rgba(100,100,120,0.3); }
  .badge-P3 { background: rgba(60,60,80,0.15); color: #8888a0; border: 1px solid rgba(60,60,80,0.3); }

  /* Role badges */
  .role-badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 10px; font-weight: 600; }
  .role-owner { background: rgba(234,179,8,0.15); color: #fde047; border: 1px solid rgba(234,179,8,0.3); }
  .role-admin { background: rgba(168,85,247,0.15); color: #c4b5fd; border: 1px solid rgba(168,85,247,0.3); }
  .role-member { background: rgba(59,130,246,0.15); color: #93c5fd; border: 1px solid rgba(59,130,246,0.3); }
  .role-viewer { background: rgba(100,100,120,0.15); color: #a5a5b5; border: 1px solid rgba(100,100,120,0.3); }

  /* Scope badges */
  .scope-admin { background: rgba(234,179,8,0.15); color: #fde047; }
  .scope-write { background: rgba(34,197,94,0.15); color: #86efac; }
  .scope-read { background: rgba(100,100,120,0.15); color: #a5a5b5; }

  /* Event feed items */
  .ev { border-left: 3px solid #22222e; padding: 8px 12px; margin-bottom: 4px; background: #0e0e16; border-radius: 0 8px 8px 0; font-size: 12px; transition: background 0.15s ease; }
  .ev:hover { background: #14141e; }
  .ev-BROADCAST { border-left-color: #6366f1; }
  .ev-LEARNING { border-left-color: #a855f7; }
  .ev-TASK_UPDATE { border-left-color: #22c55e; }
  .ev-ERROR { border-left-color: #ef4444; }
  .ev-ESCALATION { border-left-color: #f59e0b; }

  /* Tabs */
  .tab-btn {
    padding: 8px 16px; border-radius: 8px; font-size: 13px; font-weight: 500;
    color: #6b7280; cursor: pointer; background: transparent; border: 1px solid transparent;
    transition: all 0.2s ease; white-space: nowrap;
  }
  .tab-btn:hover { color: #d1d5db; background: rgba(255,255,255,0.03); }
  .tab-btn.active { background: #1a1a24; color: #e2e2ea; border-color: #2a2a38; box-shadow: 0 0 0 1px rgba(99,102,241,0.1); }
  .tab-panel { display: none; }
  .tab-panel.active { display: block; animation: fadeIn 0.2s ease; }

  @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes pulse { 0%, 100% { opacity: 0.4; } 50% { opacity: 0.7; } }
  @keyframes slideIn { from { opacity: 0; transform: translateX(20px); } to { opacity: 1; transform: translateX(0); } }

  /* Skeleton loading */
  .skeleton {
    background: linear-gradient(90deg, #1a1a24 25%, #22222e 50%, #1a1a24 75%);
    background-size: 200% 100%;
    animation: skeleton-shimmer 1.5s infinite;
    border-radius: 6px;
  }
  @keyframes skeleton-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

  /* Graph */
  .graph-node { cursor: pointer; transition: transform 0.15s ease; }
  .graph-node:hover { transform: scale(1.1); }
  .graph-node:hover circle { stroke: #6366f1; stroke-width: 2.5; }

  /* Tooltip */
  .tip { position: fixed; z-index: 60; pointer-events: none; background: #12121a; border: 1px solid #2a2a38; border-radius: 8px; padding: 10px 12px; font-size: 12px; max-width: 340px; display: none; box-shadow: 0 8px 24px rgba(0,0,0,0.6); }

  /* Modal */
  .modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,0.85); backdrop-filter: blur(4px); z-index: 70; display: none; align-items: center; justify-content: center; padding: 20px; }
  .modal-bg.open { display: flex; }
  .modal-box { background: #12121a; border: 1px solid #2a2a38; border-radius: 12px; max-width: 800px; width: 100%; max-height: 85vh; display: flex; flex-direction: column; box-shadow: 0 16px 48px rgba(0,0,0,0.5); }

  /* Toast */
  .toast { position: fixed; bottom: 20px; right: 20px; background: #12121a; border: 1px solid #22222e; border-left: 3px solid #22c55e; padding: 12px 16px; border-radius: 8px; font-size: 13px; z-index: 80; box-shadow: 0 8px 24px rgba(0,0,0,0.5); animation: slideIn 0.3s ease; }
  .toast.err { border-left-color: #ef4444; }

  /* Cards */
  .art-card { background: #0e0e16; border: 1px solid #22222e; border-radius: 8px; padding: 14px; cursor: pointer; transition: all 0.2s ease; }
  .art-card:hover { border-color: #3a3a4a; background: #14141e; transform: translateY(-1px); }
  .pb-row { background: #0e0e16; border: 1px solid #22222e; border-radius: 8px; padding: 14px; display: flex; align-items: center; justify-content: space-between; gap: 12px; transition: border-color 0.2s ease; }
  .pb-row:hover { border-color: #3a3a4a; }

  /* SSE connection indicator */
  .conn-indicator { display: flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 6px; font-size: 11px; font-weight: 500; }
  .conn-live { background: rgba(34,197,94,0.1); color: #86efac; }
  .conn-connecting { background: rgba(234,179,8,0.1); color: #fde047; }
  .conn-error { background: rgba(239,68,68,0.1); color: #fca5a5; }

  /* Progress bar */
  .progress-bar { height: 6px; border-radius: 3px; background: #1a1a24; overflow: hidden; }
  .progress-fill { height: 100%; border-radius: 3px; transition: width 0.5s ease; }

  /* Table styles */
  .data-table { width: 100%; font-size: 13px; }
  .data-table th { text-align: left; padding: 10px 12px; color: #6b7280; font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 1px solid #22222e; }
  .data-table td { padding: 10px 12px; border-bottom: 1px solid rgba(34,34,46,0.5); }
  .data-table tr:hover td { background: rgba(255,255,255,0.02); }
  .data-table tr:last-child td { border-bottom: none; }

  /* Buttons */
  .btn-primary { background: #6366f1; color: #fff; padding: 8px 16px; border-radius: 8px; font-size: 13px; font-weight: 500; border: none; cursor: pointer; transition: all 0.15s ease; }
  .btn-primary:hover { background: #818cf8; }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-ghost { background: transparent; color: #9ca3af; padding: 6px 12px; border-radius: 6px; font-size: 12px; font-weight: 500; border: 1px solid #22222e; cursor: pointer; transition: all 0.15s ease; }
  .btn-ghost:hover { color: #e2e2ea; border-color: #3a3a4a; background: rgba(255,255,255,0.03); }
  .btn-danger { background: rgba(239,68,68,0.1); color: #fca5a5; padding: 6px 12px; border-radius: 6px; font-size: 12px; font-weight: 500; border: 1px solid rgba(239,68,68,0.2); cursor: pointer; transition: all 0.15s ease; }
  .btn-danger:hover { background: rgba(239,68,68,0.2); }

  /* Empty state */
  .empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 40px 20px; text-align: center; }
  .empty-state svg { width: 48px; height: 48px; color: #3a3a4a; margin-bottom: 16px; }
  .empty-state .empty-title { font-size: 14px; font-weight: 500; color: #9ca3af; margin-bottom: 4px; }
  .empty-state .empty-desc { font-size: 12px; color: #6b7280; max-width: 280px; }

  /* Stat card */
  .stat-card { padding: 16px; }
  .stat-label { font-size: 11px; font-weight: 500; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; }
  .stat-value { font-size: 28px; font-weight: 700; margin-top: 4px; line-height: 1.2; }
  .stat-sub { font-size: 11px; color: #4b5563; margin-top: 4px; }

  /* Responsive */
  @media (max-width: 1024px) {
    .tab-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
    .tab-scroll::-webkit-scrollbar { display: none; }
  }
  @media (max-width: 640px) {
    .stat-value { font-size: 22px; }
    .tab-btn { padding: 6px 10px; font-size: 12px; }
  }

  input, button, select { font-family: inherit; }
</style>
</head>
<body class="min-h-screen">

<!-- API Key Setup -->
<div id="setup" class="hidden fixed inset-0 z-50 flex items-center justify-center" style="background: radial-gradient(ellipse at center, #12121a 0%, #0a0a0f 70%)">
  <div class="panel p-8 w-full max-w-md" style="border-color: #2a2a38">
    <div class="flex items-center gap-3 mb-6">
      <div class="w-8 h-8 rounded-lg bg-accent/20 flex items-center justify-center">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 1L14.93 5.5V10.5L8 15L1.07 10.5V5.5L8 1Z" stroke="#6366f1" stroke-width="1.5"/></svg>
      </div>
      <h1 class="text-xl font-semibold">Lattice</h1>
    </div>
    <p class="text-sm text-gray-400 mb-6 leading-relaxed">Enter your workspace API key to connect. Keys are stored locally in your browser.</p>
    <form id="setup-form" class="space-y-4">
      <div>
        <label class="block text-xs font-medium text-gray-500 mb-1.5">API Key</label>
        <input id="key-input" type="password" placeholder="lt_..." autocomplete="off"
          class="w-full px-3 py-2.5 bg-surface-0 border border-surface-4 rounded-lg text-sm focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 transition-all" />
      </div>
      <p class="text-xs text-gray-600 leading-relaxed">Need a key? Run <code class="px-1.5 py-0.5 bg-surface-0 rounded text-gray-400 font-mono text-[11px]">npx lattice init</code> or POST <code class="px-1.5 py-0.5 bg-surface-0 rounded text-gray-400 font-mono text-[11px]">/admin/teams/:id/keys</code></p>
      <button type="submit" class="btn-primary w-full py-2.5">Connect</button>
    </form>
  </div>
</div>

<!-- Header -->
<header class="border-b border-surface-3 px-4 md:px-6 py-3">
  <div class="flex items-center justify-between gap-4">
    <div class="flex items-center gap-3 min-w-0">
      <div class="flex items-center gap-2 flex-shrink-0">
        <div class="w-7 h-7 rounded-lg bg-accent/20 flex items-center justify-center">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 1L14.93 5.5V10.5L8 15L1.07 10.5V5.5L8 1Z" stroke="#6366f1" stroke-width="1.5"/></svg>
        </div>
        <span class="font-semibold text-sm hidden sm:inline">Lattice</span>
      </div>
      <div class="h-4 w-px bg-surface-3 hidden sm:block"></div>
      <div id="workspace-info" class="min-w-0 hidden sm:block">
        <div id="ws-name" class="text-sm font-medium truncate text-gray-300"></div>
      </div>
    </div>

    <div id="conn-wrapper" class="flex-shrink-0">
      <div id="conn" class="conn-indicator conn-connecting">
        <span class="conn-dot w-1.5 h-1.5 rounded-full bg-current"></span>
        <span class="conn-text">connecting</span>
      </div>
    </div>

    <button id="logout" class="btn-ghost text-xs flex-shrink-0">Sign out</button>
  </div>

  <nav id="tabs" class="flex gap-1 mt-3 tab-scroll -mb-px">
    <button class="tab-btn active" data-tab="overview">Overview</button>
    <button class="tab-btn" data-tab="graph">Task Graph</button>
    <button class="tab-btn" data-tab="artifacts">Artifacts</button>
    <button class="tab-btn" data-tab="playbooks">Playbooks</button>
    <div class="w-px bg-surface-3 mx-1 self-stretch hidden sm:block"></div>
    <button class="tab-btn" data-tab="members">Members</button>
    <button class="tab-btn" data-tab="audit">Audit Log</button>
    <button class="tab-btn" data-tab="usage">Usage</button>
    <button class="tab-btn" data-tab="keys">API Keys</button>
  </nav>
</header>

<!-- Main Content -->
<main class="p-4 md:p-6 max-w-[1600px] mx-auto">

<!-- System Status Bar -->
<div id="system-bar" class="flex flex-wrap items-center gap-3 mb-4 text-[11px]">
  <div class="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-surface-1 border border-surface-3">
    <span class="text-gray-500">SSE</span>
    <span id="sse-state" class="font-medium text-gray-400">--</span>
  </div>
  <div class="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-surface-1 border border-surface-3">
    <span class="text-gray-500">Agents</span>
    <span id="agents-online-count" class="font-medium text-gray-400">--</span>
  </div>
  <div class="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-surface-1 border border-surface-3">
    <span class="text-gray-500">Task Reaper</span>
    <span id="reaper-status" class="font-medium text-green-400">active</span>
    <span class="text-gray-600" title="Idle tasks without heartbeat are abandoned after 30m">&#9432;</span>
  </div>
  <div class="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-surface-1 border border-surface-3">
    <span class="text-gray-500">Rate Limit</span>
    <span id="rate-limit-status" class="font-medium text-gray-400">--</span>
  </div>
  <div class="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-surface-1 border border-surface-3">
    <span class="text-gray-500">Last refresh</span>
    <span id="last-refresh-time" class="font-medium text-gray-400">--</span>
  </div>
</div>

<!-- ==================== OVERVIEW TAB ==================== -->
<div id="tab-overview" class="tab-panel active">
  <div class="grid grid-cols-1 lg:grid-cols-12 gap-4">

    <!-- Agents -->
    <section class="panel p-5 lg:col-span-3">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Agents</h2>
        <span id="agents-count-badge" class="text-[10px] text-gray-600">0</span>
      </div>
      <div id="agents" class="space-y-2 scroll" style="max-height: 70vh">
        <div class="skeleton h-10 mb-2"></div>
        <div class="skeleton h-10 mb-2"></div>
        <div class="skeleton h-10"></div>
      </div>
    </section>

    <!-- Tasks + Events -->
    <section class="lg:col-span-6 space-y-4">
      <div class="panel p-5">
        <h2 class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4">Tasks</h2>
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <div class="flex items-center gap-2 mb-2">
              <span class="w-2 h-2 rounded-full bg-gray-500"></span>
              <span class="text-xs text-gray-500 font-medium">Open</span>
              <span id="tasks-open-count" class="text-[10px] text-gray-600 ml-auto">0</span>
            </div>
            <div id="tasks-open" class="space-y-2 scroll" style="max-height: 32vh">
              <div class="skeleton h-16 mb-2"></div>
            </div>
          </div>
          <div>
            <div class="flex items-center gap-2 mb-2">
              <span class="w-2 h-2 rounded-sm bg-yellow-500 rotate-45"></span>
              <span class="text-xs text-gray-500 font-medium">Claimed</span>
              <span id="tasks-claimed-count" class="text-[10px] text-gray-600 ml-auto">0</span>
            </div>
            <div id="tasks-claimed" class="space-y-2 scroll" style="max-height: 32vh">
              <div class="skeleton h-16 mb-2"></div>
            </div>
          </div>
          <div>
            <div class="flex items-center gap-2 mb-2">
              <span class="w-2 h-2 rounded-full bg-green-500"></span>
              <span class="text-xs text-gray-500 font-medium">Completed</span>
              <span id="tasks-completed-count" class="text-[10px] text-gray-600 ml-auto">0</span>
            </div>
            <div id="tasks-completed" class="space-y-2 scroll" style="max-height: 32vh">
              <div class="skeleton h-16 mb-2"></div>
            </div>
          </div>
        </div>
      </div>

      <div class="panel p-5">
        <div class="flex items-center justify-between mb-4">
          <h2 class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Event Feed</h2>
          <span id="events-count-badge" class="text-[10px] text-gray-600">live</span>
        </div>
        <div id="feed" class="scroll" style="max-height: 35vh">
          <div class="skeleton h-12 mb-2"></div>
          <div class="skeleton h-12 mb-2"></div>
          <div class="skeleton h-12"></div>
        </div>
      </div>
    </section>

    <!-- Analytics -->
    <section class="lg:col-span-3 space-y-3">
      <h2 class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Analytics <span class="text-gray-600 font-normal">(24h)</span></h2>
      <div id="a-tasks" class="panel stat-card">
        <div class="stat-label">Tasks</div>
        <div class="stat-value text-gray-200">
          <div class="skeleton h-8 w-16"></div>
        </div>
      </div>
      <div id="a-events" class="panel stat-card">
        <div class="stat-label">Events</div>
        <div class="stat-value text-gray-200">
          <div class="skeleton h-8 w-16"></div>
        </div>
      </div>
      <div id="a-agents" class="panel stat-card">
        <div class="stat-label">Agents</div>
        <div class="stat-value text-gray-200">
          <div class="skeleton h-8 w-16"></div>
        </div>
      </div>
      <div id="a-completion" class="panel stat-card">
        <div class="stat-label">Completion Rate</div>
        <div class="stat-value text-gray-200">
          <div class="skeleton h-8 w-16"></div>
        </div>
      </div>

      <!-- Agent Heartbeat Timeline -->
      <div class="panel p-4">
        <h3 class="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-3">Agent Heartbeats</h3>
        <div id="heartbeat-timeline" class="space-y-2">
          <div class="skeleton h-4"></div>
          <div class="skeleton h-4"></div>
        </div>
      </div>
    </section>
  </div>
</div>

<!-- ==================== TASK GRAPH TAB ==================== -->
<div id="tab-graph" class="tab-panel">
  <div class="panel p-5">
    <div class="flex items-center justify-between mb-4">
      <h2 class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Task Graph DAG</h2>
      <div class="flex items-center gap-4 text-[11px] text-gray-500">
        <span class="flex items-center gap-1"><span class="w-2.5 h-2.5 rounded-full bg-gray-500"></span>open</span>
        <span class="flex items-center gap-1"><span class="w-2.5 h-2.5 rounded-sm bg-yellow-500 inline-block rotate-45"></span>claimed</span>
        <span class="flex items-center gap-1"><span class="w-2.5 h-2.5 rounded-full bg-green-500"></span>completed</span>
        <span class="flex items-center gap-1"><span class="w-2.5 h-2.5 rounded-full bg-red-500"></span>escalated</span>
        <button id="graph-refresh" class="btn-ghost">Refresh</button>
      </div>
    </div>
    <div id="graph-container" style="overflow:auto; background:#0a0a0f; border-radius:8px; border: 1px solid #22222e;">
      <svg id="graph-svg" width="1200" height="700"></svg>
    </div>
  </div>
</div>

<!-- ==================== ARTIFACTS TAB ==================== -->
<div id="tab-artifacts" class="tab-panel">
  <div class="panel p-5">
    <div class="flex items-center justify-between mb-4">
      <h2 class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Artifacts</h2>
      <button id="art-refresh" class="btn-ghost">Refresh</button>
    </div>
    <div id="artifacts-grid" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
      <div class="skeleton h-24"></div>
      <div class="skeleton h-24"></div>
      <div class="skeleton h-24"></div>
    </div>
  </div>
</div>

<!-- ==================== PLAYBOOKS TAB ==================== -->
<div id="tab-playbooks" class="tab-panel">
  <div class="panel p-5">
    <div class="flex items-center justify-between mb-4">
      <h2 class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Playbooks</h2>
      <button id="pb-refresh" class="btn-ghost">Refresh</button>
    </div>
    <div id="playbooks-list" class="space-y-2">
      <div class="skeleton h-16 mb-2"></div>
      <div class="skeleton h-16"></div>
    </div>
  </div>
</div>

<!-- ==================== MEMBERS TAB ==================== -->
<div id="tab-members" class="tab-panel">
  <div class="panel p-5">
    <div class="flex items-center justify-between mb-4">
      <h2 class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Workspace Members</h2>
      <span id="members-count" class="text-[10px] text-gray-600">0 members</span>
    </div>
    <div id="members-table-wrapper">
      <div class="skeleton h-10 mb-2"></div>
      <div class="skeleton h-10 mb-2"></div>
      <div class="skeleton h-10"></div>
    </div>
  </div>
</div>

<!-- ==================== AUDIT LOG TAB ==================== -->
<div id="tab-audit" class="tab-panel">
  <div class="panel p-5">
    <div class="flex items-center justify-between mb-4">
      <div>
        <h2 class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Audit Log</h2>
        <p class="text-[11px] text-gray-600 mt-1">Every action performed in this workspace</p>
      </div>
      <div class="flex items-center gap-2">
        <select id="audit-filter-action" class="bg-surface-0 border border-surface-3 rounded-lg px-2 py-1.5 text-xs text-gray-400 focus:outline-none focus:border-accent">
          <option value="">All actions</option>
        </select>
        <button id="audit-refresh" class="btn-ghost">Refresh</button>
      </div>
    </div>
    <div id="audit-table-wrapper" class="scroll" style="max-height: 65vh">
      <div class="skeleton h-10 mb-2"></div>
      <div class="skeleton h-10 mb-2"></div>
      <div class="skeleton h-10 mb-2"></div>
      <div class="skeleton h-10"></div>
    </div>
    <div id="audit-pagination" class="flex justify-center mt-4 hidden">
      <button id="audit-load-more" class="btn-ghost">Load more</button>
    </div>
  </div>
</div>

<!-- ==================== USAGE TAB ==================== -->
<div id="tab-usage" class="tab-panel">
  <div class="panel p-5">
    <div class="flex items-center justify-between mb-6">
      <div>
        <h2 class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Usage &amp; Quotas</h2>
        <p id="usage-plan-name" class="text-[11px] text-gray-600 mt-1">Current billing period</p>
      </div>
      <button id="usage-refresh" class="btn-ghost">Refresh</button>
    </div>
    <div id="usage-content" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      <div class="skeleton h-32"></div>
      <div class="skeleton h-32"></div>
      <div class="skeleton h-32"></div>
    </div>
  </div>
</div>

<!-- ==================== API KEYS TAB ==================== -->
<div id="tab-keys" class="tab-panel">
  <div class="panel p-5">
    <div class="flex items-center justify-between mb-4">
      <div>
        <h2 class="text-xs font-semibold text-gray-400 uppercase tracking-wider">API Keys</h2>
        <p class="text-[11px] text-gray-600 mt-1">Manage workspace API keys</p>
      </div>
      <span id="keys-count" class="text-[10px] text-gray-600">0 keys</span>
    </div>
    <div id="keys-table-wrapper">
      <div class="skeleton h-10 mb-2"></div>
      <div class="skeleton h-10 mb-2"></div>
      <div class="skeleton h-10"></div>
    </div>
  </div>
</div>

</main>

<!-- Tooltip -->
<div id="tip" class="tip"></div>

<!-- Modal -->
<div id="modal" class="modal-bg">
  <div class="modal-box">
    <div class="flex items-center justify-between p-4 border-b border-surface-3">
      <div id="modal-title" class="text-sm font-semibold"></div>
      <button id="modal-close" class="text-gray-500 hover:text-gray-200 text-lg leading-none">&times;</button>
    </div>
    <div id="modal-body" class="p-4 overflow-auto text-xs font-mono" style="white-space: pre-wrap;"></div>
  </div>
</div>

<script>
(() => {
  const KEY_STORE = 'lattice.apiKey';
  let apiKey = localStorage.getItem(KEY_STORE);

  const $ = (id) => document.getElementById(id);

  // ---------- Setup / Auth ----------
  function showSetup() {
    $('setup').classList.remove('hidden');
    $('setup-form').onsubmit = (e) => {
      e.preventDefault();
      const v = $('key-input').value.trim();
      if (!v) return;
      localStorage.setItem(KEY_STORE, v);
      location.reload();
    };
  }

  $('logout').onclick = () => {
    localStorage.removeItem(KEY_STORE);
    location.reload();
  };

  if (!apiKey) { showSetup(); return; }

  // ---------- API helper ----------
  let apiCallCount = 0;

  async function api(path, opts) {
    apiCallCount++;
    const r = await fetch('/api/v1' + path, {
      ...opts,
      headers: { 'Authorization': 'Bearer ' + apiKey, ...(opts && opts.headers || {}) }
    });
    if (r.status === 401) {
      localStorage.removeItem(KEY_STORE);
      showSetup();
      throw new Error('unauthorized');
    }
    if (r.status === 429) {
      $('rate-limit-status').textContent = 'throttled';
      $('rate-limit-status').className = 'font-medium text-yellow-400';
      throw new Error('rate_limited');
    }
    return r.json();
  }

  // ---------- Utilities ----------
  function agentColor(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
    return 'hsl(' + Math.abs(h) % 360 + ', 55%, 65%)';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function humanSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024*1024) return (n/1024).toFixed(1) + ' KB';
    if (n < 1024*1024*1024) return (n/(1024*1024)).toFixed(1) + ' MB';
    return (n/(1024*1024*1024)).toFixed(2) + ' GB';
  }

  function timeAgo(iso) {
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s/60) + 'm ago';
    if (s < 86400) return Math.floor(s/3600) + 'h ago';
    return Math.floor(s/86400) + 'd ago';
  }

  function toast(msg, isErr) {
    const el = document.createElement('div');
    el.className = 'toast' + (isErr ? ' err' : '');
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }

  function emptyState(icon, title, desc) {
    return '<div class="empty-state">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="' + icon + '"/></svg>' +
      '<div class="empty-title">' + escapeHtml(title) + '</div>' +
      '<div class="empty-desc">' + escapeHtml(desc) + '</div>' +
    '</div>';
  }

  const EMPTY_ICONS = {
    agents: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
    tasks: 'M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11',
    events: 'M13 2L3 14h9l-1 8 10-12h-9l1-8',
    artifacts: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8ZM14 2v6h6M16 13H8M16 17H8M10 9H8',
    playbooks: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20M4 19.5A2.5 2.5 0 0 0 6.5 22H20V2H6.5A2.5 2.5 0 0 0 4 4.5v15Z',
    members: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M12 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
    audit: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8ZM14 2v6h6M16 13H8M16 17H8M10 9H8',
    keys: 'M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777Zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4',
  };

  // ---------- Tabs ----------
  const tabLoaded = { overview: true, graph: false, artifacts: false, playbooks: false, members: false, audit: false, usage: false, keys: false };

  $('tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-btn');
    if (!btn) return;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    const name = btn.dataset.tab;
    $('tab-' + name).classList.add('active');
    if (name === 'graph' && !tabLoaded.graph) { tabLoaded.graph = true; loadGraph(); }
    else if (name === 'artifacts' && !tabLoaded.artifacts) { tabLoaded.artifacts = true; loadArtifacts(); }
    else if (name === 'playbooks' && !tabLoaded.playbooks) { tabLoaded.playbooks = true; loadPlaybooks(); }
    // Members, audit, usage, keys are loaded from snapshot data; re-render is handled by refreshAll
  });

  // ---------- State ----------
  let snapshotData = null;
  let auditCursor = null;
  let allAuditEntries = [];

  // ---------- Overview Renderers ----------
  function renderAgents(list) {
    const el = $('agents');
    $('agents-count-badge').textContent = list.length;
    const onlineCount = list.filter(a => a.status === 'online').length;
    $('agents-online-count').textContent = onlineCount + '/' + list.length;

    if (list.length === 0) {
      el.innerHTML = emptyState(EMPTY_ICONS.agents, 'No agents registered', 'Agents auto-register on first MCP call. Connect an agent to see it here.');
      return;
    }
    el.innerHTML = list.map(a => {
      const st = a.status || 'offline';
      const caps = (a.capabilities || []).slice(0, 3).join(', ');
      const hb = a.lastHeartbeat ? timeAgo(a.lastHeartbeat) : 'never';
      return '<div class="flex items-start gap-2 p-2 rounded-lg hover:bg-surface-0 transition-colors status-' + st + '">' +
        '<span class="status-dot mt-1"></span>' +
        '<div class="min-w-0 flex-1">' +
          '<div class="text-sm font-medium truncate" style="color:' + agentColor(a.id) + '">' + escapeHtml(a.id) + '</div>' +
          (caps ? '<div class="text-[11px] text-gray-500 truncate mt-0.5">' + escapeHtml(caps) + '</div>' : '') +
          '<div class="text-[10px] text-gray-600 mt-0.5">heartbeat: ' + hb + '</div>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  function taskCard(t) {
    const p = t.priority || 'P2';
    const who = t.claimedBy || t.assignedTo || '--';
    const age = timeAgo(t.createdAt);
    return '<div class="panel p-3 text-xs">' +
      '<div class="flex items-center gap-2 mb-1.5">' +
        '<span class="badge badge-' + p + '">' + p + '</span>' +
        '<span class="text-[10px] text-gray-600">#' + t.id + '</span>' +
        '<span class="text-[10px] text-gray-600 ml-auto">' + age + '</span>' +
      '</div>' +
      '<div class="text-gray-300 leading-snug mb-1" style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">' + escapeHtml((t.description || '').slice(0, 200)) + '</div>' +
      '<div class="text-[10px] text-gray-500"><span style="color:' + agentColor(who) + '">' + escapeHtml(who) + '</span></div>' +
    '</div>';
  }

  function renderTasks(list) {
    const cols = { open: [], claimed: [], completed: [] };
    for (const t of list) {
      if (cols[t.status]) cols[t.status].push(t);
    }
    for (const k of Object.keys(cols)) {
      const el = $('tasks-' + k);
      $('tasks-' + k + '-count').textContent = cols[k].length;
      if (cols[k].length === 0) {
        el.innerHTML = '<div class="text-[11px] text-gray-600 py-4 text-center">None</div>';
      } else {
        el.innerHTML = cols[k].map(taskCard).join('');
      }
    }
  }

  function renderAnalytics(a) {
    if (!a) return;
    const tasks = a.tasks || {};
    const events = a.events || {};
    const agents = a.agents || {};
    const total = tasks.total || 0;
    const done = tasks.byStatus?.completed || 0;
    const rate = total > 0 ? Math.round((done / total) * 100) + '%' : '0%';
    $('a-tasks').querySelector('.stat-value').textContent = total;
    $('a-events').querySelector('.stat-value').textContent = events.total ?? 0;
    $('a-agents').querySelector('.stat-value').textContent = agents.total ?? 0;
    $('a-completion').querySelector('.stat-value').textContent = rate;
  }

  function renderHeartbeats(agents) {
    const el = $('heartbeat-timeline');
    if (!agents || agents.length === 0) {
      el.innerHTML = '<div class="text-[11px] text-gray-600 text-center py-2">No agents</div>';
      return;
    }
    const now = Date.now();
    el.innerHTML = agents.slice(0, 8).map(a => {
      const hbTime = a.lastHeartbeat ? new Date(a.lastHeartbeat).getTime() : 0;
      const ago = hbTime ? Math.floor((now - hbTime) / 1000) : Infinity;
      // Green <60s, yellow <300s, red >300s, gray if never
      let barColor = '#22c55e';
      let barWidth = 100;
      if (ago === Infinity) { barColor = '#3a3a4a'; barWidth = 5; }
      else if (ago > 1800) { barColor = '#ef4444'; barWidth = 10; }
      else if (ago > 300) { barColor = '#f59e0b'; barWidth = Math.max(20, 100 - (ago / 18)); }
      else { barWidth = Math.max(40, 100 - (ago / 3)); }

      return '<div class="flex items-center gap-2">' +
        '<span class="text-[10px] text-gray-500 w-16 truncate" style="color:' + agentColor(a.id) + '">' + escapeHtml(a.id.slice(0, 10)) + '</span>' +
        '<div class="flex-1 progress-bar"><div class="progress-fill" style="width:' + barWidth + '%; background:' + barColor + '"></div></div>' +
        '<span class="text-[10px] text-gray-600 w-10 text-right">' + (ago === Infinity ? '--' : (ago < 60 ? ago + 's' : Math.floor(ago/60) + 'm')) + '</span>' +
      '</div>';
    }).join('');
  }

  function prependEvent(ev) {
    const time = new Date(ev.createdAt).toLocaleTimeString();
    const div = document.createElement('div');
    div.className = 'ev ev-' + (ev.eventType || 'BROADCAST');
    if (ev.id) div.dataset.eid = String(ev.id);
    div.innerHTML =
      '<div class="flex justify-between text-[10px] text-gray-500">' +
        '<span style="color:' + agentColor(ev.createdBy || 'unknown') + '">' + escapeHtml(ev.createdBy || 'unknown') + '</span>' +
        '<span>' + time + ' &middot; <span class="font-medium">' + escapeHtml(ev.eventType || '') + '</span></span>' +
      '</div>' +
      '<div class="mt-1 text-gray-300 leading-snug">' + escapeHtml((ev.message || '').slice(0, 300)) + '</div>';
    const feed = $('feed');
    // Remove skeletons on first real event
    if (feed.querySelector('.skeleton')) feed.innerHTML = '';
    feed.insertBefore(div, feed.firstChild);
    while (feed.children.length > 100) feed.removeChild(feed.lastChild);
  }

  // ---------- Members Renderer ----------
  function renderMembers(members) {
    const el = $('members-table-wrapper');
    $('members-count').textContent = members.length + ' member' + (members.length !== 1 ? 's' : '');
    if (members.length === 0) {
      el.innerHTML = emptyState(EMPTY_ICONS.members, 'No members found', 'Members are added via workspace invitations or OAuth sign-up.');
      return;
    }
    el.innerHTML = '<table class="data-table">' +
      '<thead><tr><th>User</th><th>Role</th><th>Joined</th></tr></thead>' +
      '<tbody>' + members.map(m => {
        const display = m.name || m.email || m.userId;
        const sub = m.email && m.name ? m.email : m.userId;
        return '<tr>' +
          '<td><div class="flex items-center gap-2">' +
            '<div class="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-semibold" style="background:' + agentColor(display) + '30; color:' + agentColor(display) + '">' + escapeHtml(display.charAt(0).toUpperCase()) + '</div>' +
            '<div><div class="text-sm font-medium text-gray-200">' + escapeHtml(display) + '</div>' +
            '<div class="text-[11px] text-gray-500">' + escapeHtml(sub) + '</div></div>' +
          '</div></td>' +
          '<td><span class="role-badge role-' + m.role + '">' + m.role + '</span></td>' +
          '<td class="text-gray-500 text-xs">' + (m.joinedAt ? timeAgo(m.joinedAt) : '--') + '</td>' +
        '</tr>';
      }).join('') +
      '</tbody></table>';
  }

  // ---------- Audit Log Renderer ----------
  function renderAudit(entries, append) {
    const el = $('audit-table-wrapper');
    if (!append) allAuditEntries = entries;
    else allAuditEntries = allAuditEntries.concat(entries);

    // Build action filter options
    const actions = [...new Set(allAuditEntries.map(e => e.action))].sort();
    const filterEl = $('audit-filter-action');
    const currentFilter = filterEl.value;
    filterEl.innerHTML = '<option value="">All actions</option>' +
      actions.map(a => '<option value="' + escapeHtml(a) + '"' + (a === currentFilter ? ' selected' : '') + '>' + escapeHtml(a) + '</option>').join('');

    const filtered = currentFilter ? allAuditEntries.filter(e => e.action === currentFilter) : allAuditEntries;

    if (filtered.length === 0) {
      el.innerHTML = emptyState(EMPTY_ICONS.audit, 'No audit entries', 'Actions performed in this workspace will appear here.');
      $('audit-pagination').classList.add('hidden');
      return;
    }

    el.innerHTML = '<table class="data-table">' +
      '<thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Resource</th><th>IP</th></tr></thead>' +
      '<tbody>' + filtered.map(e => {
        return '<tr>' +
          '<td class="text-gray-500 text-[11px] whitespace-nowrap">' + new Date(e.createdAt).toLocaleString() + '</td>' +
          '<td><span class="text-xs font-medium" style="color:' + agentColor(e.actor || 'system') + '">' + escapeHtml(e.actor || 'system') + '</span></td>' +
          '<td><span class="text-xs font-mono text-gray-300">' + escapeHtml(e.action) + '</span></td>' +
          '<td class="text-xs text-gray-500">' + escapeHtml(e.resource || '--') + '</td>' +
          '<td class="text-[11px] text-gray-600">' + escapeHtml(e.ip || '--') + '</td>' +
        '</tr>';
      }).join('') +
      '</tbody></table>';
  }

  $('audit-filter-action').onchange = () => renderAudit([], false);
  $('audit-refresh').onclick = () => { allAuditEntries = []; refreshAll(); };

  // ---------- Usage Renderer ----------
  function renderUsage(usage, limits) {
    const el = $('usage-content');

    if (!usage || !limits) {
      el.innerHTML = emptyState(EMPTY_ICONS.tasks, 'Usage data unavailable', 'Usage tracking may not be configured for this workspace.');
      return;
    }

    $('usage-plan-name').textContent = 'Plan: ' + (limits.plan_name || 'Free') + ' -- Current billing period';

    function usageCard(label, used, quota, unit) {
      const pct = quota > 0 ? Math.min(100, Math.round((used / quota) * 100)) : 0;
      let color = '#22c55e';
      if (pct > 90) color = '#ef4444';
      else if (pct > 70) color = '#f59e0b';
      const usedStr = unit === 'bytes' ? humanSize(used) : used.toLocaleString();
      const quotaStr = unit === 'bytes' ? humanSize(quota) : quota.toLocaleString();

      return '<div class="panel p-5">' +
        '<div class="text-xs font-medium text-gray-400 mb-3">' + label + '</div>' +
        '<div class="text-2xl font-bold text-gray-200 mb-1">' + usedStr + '</div>' +
        '<div class="text-[11px] text-gray-500 mb-3">of ' + quotaStr + ' (' + pct + '%)</div>' +
        '<div class="progress-bar"><div class="progress-fill" style="width:' + pct + '%; background:' + color + '"></div></div>' +
        (pct > 90 ? '<div class="text-[11px] text-red-400 mt-2 flex items-center gap-1"><span>&#9888;</span> Approaching limit</div>' : '') +
      '</div>';
    }

    el.innerHTML =
      usageCard('Executions', usage.exec_count, limits.exec_quota, 'count') +
      usageCard('API Calls', usage.api_call_count, limits.api_call_quota, 'count') +
      usageCard('Storage', usage.storage_bytes, limits.storage_bytes_quota, 'bytes');

    // Add seat usage if we have members data
    if (snapshotData && snapshotData.members) {
      el.innerHTML += usageCard('Seats', snapshotData.members.length, limits.seat_quota, 'count');
    }
  }

  $('usage-refresh').onclick = () => refreshAll();

  // ---------- API Keys Renderer ----------
  function renderKeys(keys) {
    const el = $('keys-table-wrapper');
    const activeKeys = keys.filter(k => !k.revokedAt);
    $('keys-count').textContent = activeKeys.length + ' active, ' + keys.length + ' total';

    if (keys.length === 0) {
      el.innerHTML = emptyState(EMPTY_ICONS.keys, 'No API keys', 'Create an API key to allow agents to connect to this workspace.');
      return;
    }

    el.innerHTML = '<table class="data-table">' +
      '<thead><tr><th>ID</th><th>Label</th><th>Scope</th><th>Created</th><th>Last Used</th><th>Status</th></tr></thead>' +
      '<tbody>' + keys.map(k => {
        const isRevoked = !!k.revokedAt;
        const isExpired = k.expiresAt && new Date(k.expiresAt) < new Date();
        let statusHtml;
        if (isRevoked) {
          statusHtml = '<span class="badge" style="background:rgba(239,68,68,0.1);color:#fca5a5;border:1px solid rgba(239,68,68,0.2)">revoked</span>';
        } else if (isExpired) {
          statusHtml = '<span class="badge" style="background:rgba(234,179,8,0.1);color:#fde047;border:1px solid rgba(234,179,8,0.2)">expired</span>';
        } else {
          statusHtml = '<span class="badge" style="background:rgba(34,197,94,0.1);color:#86efac;border:1px solid rgba(34,197,94,0.2)">active</span>';
        }

        return '<tr style="' + (isRevoked ? 'opacity:0.5' : '') + '">' +
          '<td class="text-xs font-mono text-gray-400">' + k.id + '</td>' +
          '<td class="text-xs text-gray-300">' + escapeHtml(k.label || '--') + '</td>' +
          '<td><span class="badge scope-' + k.scope + '">' + k.scope + '</span></td>' +
          '<td class="text-[11px] text-gray-500">' + (k.createdAt ? timeAgo(k.createdAt) : '--') + '</td>' +
          '<td class="text-[11px] text-gray-500">' + (k.lastUsedAt ? timeAgo(k.lastUsedAt) : 'never') + '</td>' +
          '<td>' + statusHtml + '</td>' +
        '</tr>';
      }).join('') +
      '</tbody></table>';
  }

  // ---------- Refresh All (from snapshot) ----------
  let lastRefreshAt = 0;
  const REFRESH_DEBOUNCE_MS = 5000;

  async function refreshAll() {
    const now = Date.now();
    if (now - lastRefreshAt < REFRESH_DEBOUNCE_MS) return;
    lastRefreshAt = now;
    try {
      const snap = await api('/dashboard-snapshot');
      snapshotData = snap;

      // Workspace info
      if (snap.workspace) {
        $('ws-name').textContent = snap.workspace.name || snap.workspace.id;
        $('workspace-info').classList.remove('hidden');
        document.title = (snap.workspace.name || snap.workspace.id) + ' -- Lattice';
      }

      // Rate limit status
      $('rate-limit-status').textContent = 'ok (' + apiCallCount + ' calls)';
      $('rate-limit-status').className = 'font-medium text-green-400';

      // Last refresh
      $('last-refresh-time').textContent = new Date().toLocaleTimeString();

      // Overview
      renderAgents(snap.agents || []);
      renderTasks(snap.tasks || []);
      renderAnalytics(snap.analytics || null);
      renderHeartbeats(snap.agents || []);

      // Events (dedup)
      const feed = $('feed');
      if (feed.querySelector('.skeleton')) feed.innerHTML = '';
      const existingIds = new Set();
      feed.querySelectorAll('[data-eid]').forEach(el => existingIds.add(el.dataset.eid));
      const eventsToAdd = (snap.recentEvents || []).filter(ev => !existingIds.has(String(ev.id)));
      if (eventsToAdd.length > 0) {
        for (const ev of eventsToAdd) prependEvent(ev);
      } else if (feed.children.length === 0) {
        feed.innerHTML = emptyState(EMPTY_ICONS.events, 'No events yet', 'Events appear here as agents broadcast updates, complete tasks, or share learnings.');
      }

      // Admin tabs data (always render from snapshot)
      renderMembers(snap.members || []);
      if (allAuditEntries.length === 0) renderAudit(snap.auditLog || [], false);
      renderUsage(snap.usage, snap.limits);
      renderKeys(snap.apiKeys || []);

    } catch (e) {
      if (e.message !== 'unauthorized' && e.message !== 'rate_limited') {
        console.error('refresh failed', e);
      }
    }
  }

  // ---------- Task Graph ----------
  const STATUS_COLOR = {
    open: '#6b7280', claimed: '#eab308', completed: '#22c55e',
    escalated: '#dc2626', abandoned: '#dc2626',
  };

  async function loadGraph() {
    try {
      const g = await api('/tasks/graph?limit=50');
      renderGraph(g.nodes || [], g.edges || []);
    } catch (e) { toast('Failed to load graph', true); }
  }

  function layoutGraph(nodes, edges) {
    const byId = new Map(nodes.map(n => [n.id, n]));
    const incoming = new Map(nodes.map(n => [n.id, 0]));
    const children = new Map(nodes.map(n => [n.id, []]));
    for (const e of edges) {
      if (!byId.has(e.from) || !byId.has(e.to)) continue;
      incoming.set(e.to, (incoming.get(e.to) || 0) + 1);
      children.get(e.from).push(e.to);
    }
    const depth = new Map();
    const queue = [];
    for (const n of nodes) if ((incoming.get(n.id) || 0) === 0) { depth.set(n.id, 0); queue.push(n.id); }
    while (queue.length) {
      const id = queue.shift();
      const d = depth.get(id);
      for (const ch of children.get(id) || []) {
        const nd = Math.max(depth.get(ch) ?? 0, d + 1);
        if (depth.get(ch) !== nd) { depth.set(ch, nd); queue.push(ch); }
      }
    }
    const levels = new Map();
    for (const n of nodes) {
      const d = depth.get(n.id) ?? 0;
      if (!levels.has(d)) levels.set(d, []);
      levels.get(d).push(n);
    }
    const dx = 180, dy = 110, pad = 60;
    const pos = new Map();
    const sortedLevels = [...levels.keys()].sort((a,b) => a - b);
    let maxCols = 0;
    for (const d of sortedLevels) maxCols = Math.max(maxCols, levels.get(d).length);
    for (const d of sortedLevels) {
      const row = levels.get(d);
      const offset = (maxCols - row.length) * dx / 2;
      row.forEach((n, i) => {
        pos.set(n.id, { x: pad + offset + i * dx, y: pad + d * dy });
      });
    }
    const width = pad * 2 + maxCols * dx;
    const height = pad * 2 + sortedLevels.length * dy;
    return { pos, width, height };
  }

  function renderGraph(nodes, edges) {
    const svg = $('graph-svg');
    svg.innerHTML = '';
    if (nodes.length === 0) {
      svg.innerHTML = '<text x="20" y="40" fill="#6b7280" font-size="12">No tasks yet. Create tasks via MCP or the API to see the dependency graph.</text>';
      return;
    }
    const { pos, width, height } = layoutGraph(nodes, edges);
    svg.setAttribute('width', Math.max(width, 800));
    svg.setAttribute('height', Math.max(height, 400));

    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    defs.innerHTML = '<marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#4b5563"/></marker>';
    svg.appendChild(defs);

    for (const e of edges) {
      const a = pos.get(e.from), b = pos.get(e.to);
      if (!a || !b) continue;
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.sqrt(dx*dx + dy*dy) || 1;
      const tx = b.x - (dx/len) * 24, ty = b.y - (dy/len) * 24;
      line.setAttribute('x1', a.x); line.setAttribute('y1', a.y);
      line.setAttribute('x2', tx); line.setAttribute('y2', ty);
      line.setAttribute('stroke', '#2a2a38'); line.setAttribute('stroke-width', '1.5');
      line.setAttribute('marker-end', 'url(#arrow)');
      svg.appendChild(line);
    }

    const tip = $('tip');
    for (const n of nodes) {
      const p = pos.get(n.id);
      if (!p) continue;
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('class', 'graph-node');
      g.setAttribute('transform', 'translate(' + p.x + ',' + p.y + ')');
      const color = STATUS_COLOR[n.status] || '#6b7280';
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('r', 20);
      circle.setAttribute('fill', color);
      circle.setAttribute('fill-opacity', '0.2');
      circle.setAttribute('stroke', color);
      circle.setAttribute('stroke-width', '2');
      g.appendChild(circle);
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('dy', '4');
      text.setAttribute('fill', '#e2e2ea');
      text.setAttribute('font-size', '11');
      text.setAttribute('font-weight', '600');
      text.textContent = '#' + n.id;
      g.appendChild(text);
      g.addEventListener('mouseenter', (ev) => {
        tip.innerHTML =
          '<div class="font-semibold mb-1">Task #' + n.id + ' <span class="badge badge-' + (n.priority || 'P2') + '">' + (n.priority || 'P2') + '</span></div>' +
          '<div class="text-gray-400 mb-1">status: ' + escapeHtml(n.status) + ' &middot; assignee: ' + escapeHtml(n.claimedBy || n.assignedTo || '--') + '</div>' +
          '<div class="text-gray-200">' + escapeHtml((n.description || '').slice(0, 300)) + '</div>';
        tip.style.display = 'block';
      });
      g.addEventListener('mousemove', (ev) => {
        tip.style.left = (ev.clientX + 12) + 'px';
        tip.style.top = (ev.clientY + 12) + 'px';
      });
      g.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
      svg.appendChild(g);
    }
  }

  $('graph-refresh').onclick = loadGraph;

  // ---------- Artifacts ----------
  async function loadArtifacts() {
    try {
      const r = await api('/artifacts');
      renderArtifacts(r.artifacts || []);
    } catch (e) { toast('Failed to load artifacts', true); }
  }

  function renderArtifacts(list) {
    const el = $('artifacts-grid');
    if (list.length === 0) {
      el.innerHTML = emptyState(EMPTY_ICONS.artifacts, 'No artifacts yet', 'Use save_artifact via MCP to store files, code, or reports that agents produce.');
      return;
    }
    el.innerHTML = list.map(a => {
      return '<div class="art-card" data-key="' + escapeHtml(a.key) + '">' +
        '<div class="text-sm font-medium text-gray-200 mb-1.5 truncate">' + escapeHtml(a.key) + '</div>' +
        '<div class="flex items-center gap-2 text-[11px] text-gray-500 mb-2">' +
          '<span class="px-1.5 py-0.5 bg-surface-0 rounded text-gray-400 font-mono text-[10px]">' + escapeHtml(a.contentType) + '</span>' +
          '<span>' + humanSize(a.size) + '</span>' +
        '</div>' +
        '<div class="flex items-center justify-between text-[11px]">' +
          '<span style="color:' + agentColor(a.createdBy) + '">' + escapeHtml(a.createdBy) + '</span>' +
          '<span class="text-gray-600">' + timeAgo(a.createdAt) + '</span>' +
        '</div>' +
      '</div>';
    }).join('');
    el.querySelectorAll('.art-card').forEach(card => {
      card.onclick = () => openArtifact(card.dataset.key);
    });
  }

  async function openArtifact(key) {
    try {
      const a = await api('/artifacts/' + encodeURIComponent(key));
      const content = String(a.content || '');
      const truncated = content.length > 2000;
      const shown = truncated ? content.slice(0, 2000) + '\\n\\n...(truncated, ' + content.length + ' chars total)' : content;
      $('modal-title').textContent = a.key + '  (' + a.contentType + ', ' + humanSize(a.size) + ')';
      $('modal-body').textContent = shown;
      $('modal').classList.add('open');
    } catch (e) { toast('Failed to load artifact', true); }
  }

  $('modal-close').onclick = () => $('modal').classList.remove('open');
  $('modal').addEventListener('click', (e) => { if (e.target === $('modal')) $('modal').classList.remove('open'); });
  $('art-refresh').onclick = loadArtifacts;

  // ---------- Playbooks ----------
  async function loadPlaybooks() {
    try {
      const r = await api('/playbooks');
      renderPlaybooks(r.playbooks || []);
    } catch (e) { toast('Failed to load playbooks', true); }
  }

  function renderPlaybooks(list) {
    const el = $('playbooks-list');
    if (list.length === 0) {
      el.innerHTML = emptyState(EMPTY_ICONS.playbooks, 'No playbooks yet', 'Define reusable task templates with define_playbook via MCP, then run them to create real tasks.');
      return;
    }
    el.innerHTML = list.map(p => {
      return '<div class="pb-row">' +
        '<div class="min-w-0 flex-1">' +
          '<div class="text-sm font-medium text-gray-200">' + escapeHtml(p.name) + '</div>' +
          '<div class="text-xs text-gray-400 mt-1 leading-relaxed">' + escapeHtml(p.description || '') + '</div>' +
          '<div class="text-[11px] text-gray-500 mt-1.5">' + (p.tasks || []).length + ' task(s) &middot; by <span style="color:' + agentColor(p.createdBy) + '">' + escapeHtml(p.createdBy) + '</span></div>' +
        '</div>' +
        '<button class="btn-primary text-xs" data-run="' + escapeHtml(p.name) + '">Run</button>' +
      '</div>';
    }).join('');
    el.querySelectorAll('button[data-run]').forEach(btn => {
      btn.onclick = () => runPlaybook(btn.dataset.run, btn);
    });
  }

  async function runPlaybook(name, btn) {
    btn.disabled = true;
    btn.textContent = 'Running...';
    try {
      const r = await api('/playbooks/' + encodeURIComponent(name) + '/run', { method: 'POST' });
      const n = (r.created_task_ids || []).length;
      toast('Created ' + n + ' tasks (workflow #' + r.workflow_run_id + ')');
    } catch (e) {
      toast('Failed to run playbook', true);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Run';
    }
  }

  $('pb-refresh').onclick = loadPlaybooks;

  // ---------- SSE with exponential backoff ----------
  let sseRetryDelay = 1000;
  const SSE_MAX_DELAY = 30000;
  let sseConnectedAt = null;

  function updateSSEState(state) {
    const conn = $('conn');
    const sseState = $('sse-state');
    conn.className = 'conn-indicator conn-' + state;

    if (state === 'live') {
      conn.querySelector('.conn-text').textContent = 'live';
      sseState.textContent = 'connected';
      sseState.className = 'font-medium text-green-400';
    } else if (state === 'connecting') {
      conn.querySelector('.conn-text').textContent = 'connecting';
      sseState.textContent = 'reconnecting...';
      sseState.className = 'font-medium text-yellow-400';
    } else {
      conn.querySelector('.conn-text').textContent = 'disconnected';
      sseState.textContent = 'disconnected';
      sseState.className = 'font-medium text-red-400';
    }
  }

  function connectSSE() {
    updateSSEState('connecting');
    const es = new EventSource('/api/v1/events/stream?token=' + encodeURIComponent(apiKey));
    es.onopen = () => {
      sseRetryDelay = 1000;
      sseConnectedAt = Date.now();
      updateSSEState('live');
    };
    es.onerror = () => {
      updateSSEState('connecting');
      es.close();
      setTimeout(connectSSE, sseRetryDelay);
      sseRetryDelay = Math.min(sseRetryDelay * 2, SSE_MAX_DELAY);
    };
    es.onmessage = (msg) => {
      try {
        const ev = JSON.parse(msg.data);
        prependEvent(ev);
        if (ev.eventType === 'TASK_UPDATE' || (ev.tags || []).includes('agent-registry')) {
          refreshAll();
        }
      } catch {}
    };
  }

  // ---------- Boot ----------
  refreshAll();
  connectSSE();
  setInterval(refreshAll, 30000);
})();
</script>
</body>
</html>`;
