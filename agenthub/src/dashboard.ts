// Self-contained HTML+CSS+JS dashboard for Lattice.
// Served at GET / by the Hono app. No build step, no external deps beyond CDN Tailwind.
export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Lattice Dashboard</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>
  body { background: #0a0a0a; color: #fff; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  .panel { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 8px; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
  .dot-online { background: #22c55e; }
  .dot-busy { background: #eab308; }
  .dot-offline { background: #6b7280; }
  .badge { display: inline-block; padding: 1px 6px; border-radius: 4px; font-size: 10px; font-weight: 600; }
  .badge-P0 { background: #dc2626; color: #fff; }
  .badge-P1 { background: #ea580c; color: #fff; }
  .badge-P2 { background: #404040; color: #d4d4d4; }
  .badge-P3 { background: #262626; color: #9ca3af; }
  .ev { border-left: 3px solid #374151; padding: 6px 10px; margin-bottom: 6px; background: #141414; border-radius: 0 4px 4px 0; font-size: 12px; }
  .ev-BROADCAST { border-left-color: #3b82f6; }
  .ev-LEARNING { border-left-color: #a855f7; }
  .ev-TASK_UPDATE { border-left-color: #22c55e; }
  .ev-ERROR { border-left-color: #ef4444; }
  .ev-ESCALATION { border-left-color: #f59e0b; }
  .scroll { overflow-y: auto; }
  .scroll::-webkit-scrollbar { width: 6px; }
  .scroll::-webkit-scrollbar-thumb { background: #2a2a2a; border-radius: 3px; }
  input, button { font-family: inherit; }
  .tab-btn { padding: 6px 14px; border-radius: 6px; font-size: 13px; color: #9ca3af; cursor: pointer; background: transparent; border: 1px solid transparent; }
  .tab-btn:hover { color: #e5e7eb; }
  .tab-btn.active { background: #1a1a1a; color: #fff; border-color: #2a2a2a; }
  .tab-panel { display: none; }
  .tab-panel.active { display: block; }
  .graph-node { cursor: pointer; }
  .graph-node:hover circle { stroke: #fff; stroke-width: 2; }
  .tip { position: fixed; z-index: 60; pointer-events: none; background: #0a0a0a; border: 1px solid #2a2a2a; border-radius: 6px; padding: 8px 10px; font-size: 12px; max-width: 320px; display: none; box-shadow: 0 4px 12px rgba(0,0,0,0.5); }
  .modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,0.85); z-index: 70; display: none; align-items: center; justify-content: center; padding: 20px; }
  .modal-bg.open { display: flex; }
  .modal-box { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 8px; max-width: 800px; width: 100%; max-height: 85vh; display: flex; flex-direction: column; }
  .toast { position: fixed; bottom: 20px; right: 20px; background: #1a1a1a; border: 1px solid #2a2a2a; border-left: 3px solid #22c55e; padding: 10px 14px; border-radius: 6px; font-size: 13px; z-index: 80; box-shadow: 0 4px 12px rgba(0,0,0,0.5); }
  .toast.err { border-left-color: #ef4444; }
  .art-card { background: #141414; border: 1px solid #2a2a2a; border-radius: 6px; padding: 12px; cursor: pointer; transition: border-color 0.15s; }
  .art-card:hover { border-color: #4b5563; }
  .pb-row { background: #141414; border: 1px solid #2a2a2a; border-radius: 6px; padding: 12px; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
</style>
</head>
<body class="min-h-screen">

<div id="setup" class="hidden fixed inset-0 z-50 flex items-center justify-center bg-black/90">
  <div class="panel p-8 w-full max-w-md">
    <h1 class="text-xl font-semibold mb-2">Lattice Dashboard</h1>
    <p class="text-sm text-gray-400 mb-4">Enter your team API key to continue. Stored only in your browser's localStorage.</p>
    <form id="setup-form" class="space-y-3">
      <input id="key-input" type="password" placeholder="ltk_..." autocomplete="off"
        class="w-full px-3 py-2 bg-black border border-gray-700 rounded text-sm focus:outline-none focus:border-blue-500" />
      <p class="text-xs text-gray-500">Need a key? Run <code class="px-1 py-0.5 bg-black rounded text-gray-400">npx lattice init</code> locally, or POST <code class="px-1 py-0.5 bg-black rounded text-gray-400">/admin/teams/:id/keys</code> with <code class="px-1 py-0.5 bg-black rounded text-gray-400">ADMIN_KEY</code> set.</p>
      <button type="submit" class="w-full bg-blue-600 hover:bg-blue-500 py-2 rounded text-sm font-medium">Connect</button>
    </form>
  </div>
</div>

<header class="border-b border-gray-800 px-6 py-3 flex items-center justify-between">
  <div class="flex items-center gap-3">
    <h1 class="text-lg font-semibold">Lattice Dashboard</h1>
    <span id="conn" class="text-xs text-gray-500">connecting…</span>
  </div>
  <nav id="tabs" class="flex gap-1">
    <button class="tab-btn active" data-tab="overview">Overview</button>
    <button class="tab-btn" data-tab="graph">Task Graph</button>
    <button class="tab-btn" data-tab="artifacts">Artifacts</button>
    <button class="tab-btn" data-tab="playbooks">Playbooks</button>
  </nav>
  <button id="logout" class="text-xs text-gray-500 hover:text-gray-300">clear key</button>
</header>

<main class="p-4">

<div id="tab-overview" class="tab-panel active">
  <div class="grid grid-cols-1 lg:grid-cols-4 gap-4">
    <section class="panel p-4 lg:col-span-1">
      <h2 class="text-sm font-semibold mb-3 text-gray-300">Agents</h2>
      <div id="agents" class="space-y-2 scroll" style="max-height: 70vh"></div>
    </section>
    <section class="lg:col-span-2 space-y-4">
      <div class="panel p-4">
        <h2 class="text-sm font-semibold mb-3 text-gray-300">Tasks</h2>
        <div class="grid grid-cols-3 gap-3">
          <div>
            <div class="text-xs text-gray-500 mb-2">Open</div>
            <div id="tasks-open" class="space-y-2 scroll" style="max-height: 30vh"></div>
          </div>
          <div>
            <div class="text-xs text-gray-500 mb-2">Claimed</div>
            <div id="tasks-claimed" class="space-y-2 scroll" style="max-height: 30vh"></div>
          </div>
          <div>
            <div class="text-xs text-gray-500 mb-2">Completed</div>
            <div id="tasks-completed" class="space-y-2 scroll" style="max-height: 30vh"></div>
          </div>
        </div>
      </div>
      <div class="panel p-4">
        <h2 class="text-sm font-semibold mb-3 text-gray-300">Event Feed</h2>
        <div id="feed" class="scroll" style="max-height: 35vh"></div>
      </div>
    </section>
    <section class="lg:col-span-1 space-y-3">
      <h2 class="text-sm font-semibold text-gray-300">Analytics</h2>
      <div id="a-tasks" class="panel p-4"><div class="text-xs text-gray-500">Tasks</div><div class="text-2xl font-semibold mt-1">—</div></div>
      <div id="a-events" class="panel p-4"><div class="text-xs text-gray-500">Events</div><div class="text-2xl font-semibold mt-1">—</div></div>
      <div id="a-agents" class="panel p-4"><div class="text-xs text-gray-500">Agents</div><div class="text-2xl font-semibold mt-1">—</div></div>
      <div id="a-completion" class="panel p-4"><div class="text-xs text-gray-500">Completion Rate</div><div class="text-2xl font-semibold mt-1">—</div></div>
    </section>
  </div>
</div>

<div id="tab-graph" class="tab-panel">
  <div class="panel p-4">
    <div class="flex items-center justify-between mb-3">
      <h2 class="text-sm font-semibold text-gray-300">Task Graph DAG</h2>
      <div class="flex items-center gap-4 text-xs text-gray-500">
        <span><span class="dot" style="background:#6b7280"></span>open</span>
        <span><span class="dot" style="background:#eab308"></span>claimed</span>
        <span><span class="dot" style="background:#22c55e"></span>completed</span>
        <span><span class="dot" style="background:#dc2626"></span>escalated/abandoned</span>
        <button id="graph-refresh" class="text-blue-400 hover:text-blue-300">refresh</button>
      </div>
    </div>
    <div id="graph-container" style="overflow:auto; background:#0f0f0f; border-radius:6px;">
      <svg id="graph-svg" width="1200" height="700"></svg>
    </div>
  </div>
</div>

<div id="tab-artifacts" class="tab-panel">
  <div class="panel p-4">
    <div class="flex items-center justify-between mb-3">
      <h2 class="text-sm font-semibold text-gray-300">Artifacts</h2>
      <button id="art-refresh" class="text-xs text-blue-400 hover:text-blue-300">refresh</button>
    </div>
    <div id="artifacts-grid" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3"></div>
  </div>
</div>

<div id="tab-playbooks" class="tab-panel">
  <div class="panel p-4">
    <div class="flex items-center justify-between mb-3">
      <h2 class="text-sm font-semibold text-gray-300">Playbooks</h2>
      <button id="pb-refresh" class="text-xs text-blue-400 hover:text-blue-300">refresh</button>
    </div>
    <div id="playbooks-list" class="space-y-2"></div>
  </div>
</div>

</main>

<div id="tip" class="tip"></div>
<div id="modal" class="modal-bg">
  <div class="modal-box">
    <div class="flex items-center justify-between p-4 border-b border-gray-800">
      <div id="modal-title" class="text-sm font-semibold"></div>
      <button id="modal-close" class="text-gray-500 hover:text-gray-200">✕</button>
    </div>
    <div id="modal-body" class="p-4 overflow-auto text-xs" style="white-space: pre-wrap; font-family: ui-monospace, monospace;"></div>
  </div>
</div>

<script>
(() => {
  const KEY_STORE = 'lattice.apiKey';
  let apiKey = localStorage.getItem(KEY_STORE);

  const $ = (id) => document.getElementById(id);

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

  async function api(path, opts) {
    const r = await fetch('/api/v1' + path, {
      ...opts,
      headers: { 'Authorization': 'Bearer ' + apiKey, ...(opts && opts.headers || {}) }
    });
    if (r.status === 401) {
      localStorage.removeItem(KEY_STORE);
      showSetup();
      throw new Error('unauthorized');
    }
    return r.json();
  }

  function agentColor(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
    return 'hsl(' + Math.abs(h) % 360 + ', 65%, 60%)';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function humanSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024*1024) return (n/1024).toFixed(1) + ' KB';
    return (n/(1024*1024)).toFixed(2) + ' MB';
  }

  function toast(msg, isErr) {
    const el = document.createElement('div');
    el.className = 'toast' + (isErr ? ' err' : '');
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }

  // ---------- Tabs ----------
  $('tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-btn');
    if (!btn) return;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    const name = btn.dataset.tab;
    $('tab-' + name).classList.add('active');
    if (name === 'graph') loadGraph();
    else if (name === 'artifacts') loadArtifacts();
    else if (name === 'playbooks') loadPlaybooks();
  });

  // ---------- Overview ----------
  function renderAgents(list) {
    $('agents').innerHTML = list.map(a => {
      const st = a.status || 'offline';
      const caps = (a.capabilities || []).slice(0, 3).join(', ');
      return '<div class="text-sm">' +
        '<span class="dot dot-' + st + '"></span>' +
        '<span style="color:' + agentColor(a.id) + '">' + escapeHtml(a.id) + '</span>' +
        (caps ? '<div class="text-xs text-gray-500 ml-3">' + escapeHtml(caps) + '</div>' : '') +
      '</div>';
    }).join('') || '<div class="text-xs text-gray-600">No agents yet.</div>';
  }

  function taskCard(t) {
    const p = t.priority || 'P2';
    const who = t.claimedBy || t.assignedTo || '—';
    return '<div class="panel p-2 text-xs">' +
      '<span class="badge badge-' + p + '">' + p + '</span> ' +
      '<span style="color:' + agentColor(who) + '">' + escapeHtml(who) + '</span>' +
      '<div class="text-gray-300 mt-1" style="line-height:1.35">' + escapeHtml((t.description || '').slice(0, 140)) + '</div>' +
    '</div>';
  }

  function renderTasks(list) {
    const cols = { open: [], claimed: [], completed: [] };
    for (const t of list) {
      if (cols[t.status]) cols[t.status].push(t);
    }
    for (const k of Object.keys(cols)) {
      const el = $('tasks-' + k);
      el.innerHTML = cols[k].map(taskCard).join('') || '<div class="text-xs text-gray-600">—</div>';
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
    $('a-tasks').querySelector('.text-2xl').textContent = total;
    $('a-events').querySelector('.text-2xl').textContent = events.total ?? 0;
    $('a-agents').querySelector('.text-2xl').textContent = agents.total ?? 0;
    $('a-completion').querySelector('.text-2xl').textContent = rate;
  }

  function prependEvent(ev) {
    const time = new Date(ev.createdAt).toLocaleTimeString();
    const div = document.createElement('div');
    div.className = 'ev ev-' + (ev.eventType || 'BROADCAST');
    div.innerHTML =
      '<div class="flex justify-between text-[10px] text-gray-500">' +
        '<span style="color:' + agentColor(ev.createdBy || 'unknown') + '">' + escapeHtml(ev.createdBy || 'unknown') + '</span>' +
        '<span>' + time + ' · ' + escapeHtml(ev.eventType || '') + '</span>' +
      '</div>' +
      '<div class="mt-1 text-gray-200">' + escapeHtml((ev.message || '').slice(0, 300)) + '</div>';
    const feed = $('feed');
    feed.insertBefore(div, feed.firstChild);
    while (feed.children.length > 100) feed.removeChild(feed.lastChild);
  }

  async function refreshAll() {
    try {
      const [agents, tasks, analytics] = await Promise.all([
        api('/agents'),
        api('/tasks?limit=100'),
        api('/analytics?since=24h').catch(() => null),
      ]);
      renderAgents(agents.agents || agents || []);
      renderTasks(tasks.tasks || []);
      renderAnalytics(analytics);
    } catch (e) { /* already handled */ }
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
    // Level-based topological layout: depth from roots.
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
    // Group by depth
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
      svg.innerHTML = '<text x="20" y="40" fill="#6b7280" font-size="12">No tasks yet.</text>';
      return;
    }
    const { pos, width, height } = layoutGraph(nodes, edges);
    svg.setAttribute('width', Math.max(width, 800));
    svg.setAttribute('height', Math.max(height, 400));

    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    defs.innerHTML = '<marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#4b5563"/></marker>';
    svg.appendChild(defs);

    // Edges
    for (const e of edges) {
      const a = pos.get(e.from), b = pos.get(e.to);
      if (!a || !b) continue;
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      // Shorten to edge of target circle (r=20)
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.sqrt(dx*dx + dy*dy) || 1;
      const tx = b.x - (dx/len) * 24, ty = b.y - (dy/len) * 24;
      line.setAttribute('x1', a.x); line.setAttribute('y1', a.y);
      line.setAttribute('x2', tx); line.setAttribute('y2', ty);
      line.setAttribute('stroke', '#4b5563'); line.setAttribute('stroke-width', '1.5');
      line.setAttribute('marker-end', 'url(#arrow)');
      svg.appendChild(line);
    }

    // Nodes
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
      circle.setAttribute('stroke', '#0a0a0a');
      circle.setAttribute('stroke-width', '2');
      g.appendChild(circle);
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('dy', '4');
      text.setAttribute('fill', '#fff');
      text.setAttribute('font-size', '11');
      text.setAttribute('font-weight', '600');
      text.textContent = '#' + n.id;
      g.appendChild(text);
      g.addEventListener('mouseenter', (e) => {
        tip.innerHTML =
          '<div class="font-semibold mb-1">Task #' + n.id + ' <span class="badge badge-' + (n.priority || 'P2') + '">' + (n.priority || 'P2') + '</span></div>' +
          '<div class="text-gray-400 mb-1">status: ' + escapeHtml(n.status) + ' · assignee: ' + escapeHtml(n.claimedBy || n.assignedTo || '—') + '</div>' +
          '<div class="text-gray-200">' + escapeHtml((n.description || '').slice(0, 300)) + '</div>';
        tip.style.display = 'block';
      });
      g.addEventListener('mousemove', (e) => {
        tip.style.left = (e.clientX + 12) + 'px';
        tip.style.top = (e.clientY + 12) + 'px';
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
      el.innerHTML = '<div class="text-xs text-gray-600">No artifacts yet.</div>';
      return;
    }
    el.innerHTML = list.map(a => {
      return '<div class="art-card" data-key="' + escapeHtml(a.key) + '">' +
        '<div class="text-sm font-semibold text-gray-100 mb-1" style="word-break:break-all">' + escapeHtml(a.key) + '</div>' +
        '<div class="text-[11px] text-gray-500 mb-2">' + escapeHtml(a.contentType) + ' · ' + humanSize(a.size) + '</div>' +
        '<div class="text-[11px] text-gray-400">by <span style="color:' + agentColor(a.createdBy) + '">' + escapeHtml(a.createdBy) + '</span></div>' +
        '<div class="text-[11px] text-gray-500">' + new Date(a.createdAt).toLocaleString() + '</div>' +
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
      const shown = truncated ? content.slice(0, 2000) + '\\n\\n…(truncated, ' + content.length + ' chars total)' : content;
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
      el.innerHTML = '<div class="text-xs text-gray-600">No playbooks yet.</div>';
      return;
    }
    el.innerHTML = list.map(p => {
      return '<div class="pb-row">' +
        '<div class="min-w-0 flex-1">' +
          '<div class="text-sm font-semibold">' + escapeHtml(p.name) + '</div>' +
          '<div class="text-xs text-gray-400 mt-1">' + escapeHtml(p.description || '') + '</div>' +
          '<div class="text-[11px] text-gray-500 mt-1">' + (p.tasks || []).length + ' task(s) · by <span style="color:' + agentColor(p.createdBy) + '">' + escapeHtml(p.createdBy) + '</span></div>' +
        '</div>' +
        '<button class="bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded text-xs font-medium" data-run="' + escapeHtml(p.name) + '">Run</button>' +
      '</div>';
    }).join('');
    el.querySelectorAll('button[data-run]').forEach(btn => {
      btn.onclick = () => runPlaybook(btn.dataset.run, btn);
    });
  }

  async function runPlaybook(name, btn) {
    btn.disabled = true;
    btn.textContent = 'Running…';
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

  // ---------- SSE ----------
  function connectSSE() {
    const es = new EventSource('/api/v1/events/stream?token=' + encodeURIComponent(apiKey));
    es.onopen = () => { $('conn').textContent = 'live'; $('conn').className = 'text-xs text-green-500'; };
    es.onerror = () => { $('conn').textContent = 'reconnecting…'; $('conn').className = 'text-xs text-yellow-500'; };
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

  refreshAll();
  connectSSE();
  setInterval(refreshAll, 30_000);
})();
</script>
</body>
</html>`;
