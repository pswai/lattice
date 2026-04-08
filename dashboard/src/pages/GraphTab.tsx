import { useState, useRef, useCallback, useEffect } from 'react';
import { api } from '../lib/api';
import type { Task } from '../lib/types';
import { toast } from '../components/ui/Toast';
import { Skeleton } from '../components/ui/Skeleton';

interface GraphNode extends Task {
  x?: number;
  y?: number;
}

interface GraphEdge {
  from: number;
  to: number;
}

interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const STATUS_COLOR: Record<string, string> = {
  open: '#6b7280',
  claimed: '#eab308',
  completed: '#22c55e',
  escalated: '#dc2626',
  abandoned: '#dc2626',
};

function layoutGraph(nodes: GraphNode[], edges: GraphEdge[]) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const incoming = new Map(nodes.map((n) => [n.id, 0]));
  const children = new Map(nodes.map((n) => [n.id, [] as number[]]));
  const parents = new Map(nodes.map((n) => [n.id, [] as number[]]));

  for (const e of edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue;
    incoming.set(e.to, (incoming.get(e.to) || 0) + 1);
    children.get(e.from)!.push(e.to);
    parents.get(e.to)!.push(e.from);
  }

  // Separate connected from isolated nodes
  const connected = new Set<number>();
  for (const e of edges) {
    if (byId.has(e.from)) connected.add(e.from);
    if (byId.has(e.to)) connected.add(e.to);
  }
  const isolatedNodes = nodes.filter((n) => !connected.has(n.id));
  const connectedNodes = nodes.filter((n) => connected.has(n.id));

  // BFS layering
  const depth = new Map<number, number>();
  const queue: number[] = [];
  for (const n of connectedNodes) {
    if ((incoming.get(n.id) || 0) === 0) {
      depth.set(n.id, 0);
      queue.push(n.id);
    }
  }
  while (queue.length) {
    const id = queue.shift()!;
    const d = depth.get(id)!;
    for (const ch of children.get(id) || []) {
      const nd = Math.max(depth.get(ch) ?? 0, d + 1);
      if (depth.get(ch) !== nd) {
        depth.set(ch, nd);
        queue.push(ch);
      }
    }
  }

  const dx = 160, dy = 100, pad = 60;
  const pos = new Map<number, { x: number; y: number }>();

  // Layout connected nodes in layers
  const levels = new Map<number, GraphNode[]>();
  for (const n of connectedNodes) {
    const d = depth.get(n.id) ?? 0;
    if (!levels.has(d)) levels.set(d, []);
    levels.get(d)!.push(n);
  }
  const sortedLevels = [...levels.keys()].sort((a, b) => a - b);
  let maxCols = 0;
  for (const d of sortedLevels) maxCols = Math.max(maxCols, levels.get(d)!.length);

  for (const d of sortedLevels) {
    const row = levels.get(d)!;
    const offset = (maxCols - row.length) * dx / 2;
    row.forEach((n, i) => {
      pos.set(n.id, { x: pad + offset + i * dx, y: pad + d * dy });
    });
  }

  // Layout isolated nodes in grid below
  const connectedHeight = sortedLevels.length > 0 ? pad + sortedLevels.length * dy : pad;
  const gridCols = Math.min(8, Math.max(4, Math.ceil(Math.sqrt(isolatedNodes.length))));
  for (let i = 0; i < isolatedNodes.length; i++) {
    const col = i % gridCols;
    const row = Math.floor(i / gridCols);
    pos.set(isolatedNodes[i].id, {
      x: pad + col * dx,
      y: connectedHeight + (sortedLevels.length > 0 ? 40 : 0) + row * dy,
    });
  }

  const isolatedRows = Math.ceil(isolatedNodes.length / gridCols);
  const totalCols = Math.max(maxCols, gridCols);
  const width = pad * 2 + totalCols * dx;
  const height = pad * 2
    + (sortedLevels.length > 0 ? sortedLevels.length * dy : 0)
    + (isolatedRows > 0 ? (sortedLevels.length > 0 ? 40 : 0) + isolatedRows * dy : 0);

  return { pos, width, height };
}

const LEGEND = [
  { label: 'open', color: '#6b7280', shape: 'circle' },
  { label: 'claimed', color: '#eab308', shape: 'diamond' },
  { label: 'completed', color: '#22c55e', shape: 'circle' },
  { label: 'escalated', color: '#dc2626', shape: 'circle' },
  { label: 'abandoned', color: '#dc2626', shape: 'circle' },
];

const ALL_STATUSES = ['open', 'claimed', 'completed', 'escalated', 'abandoned'] as const;
const DEFAULT_ACTIVE = new Set(['open', 'claimed']);

export default function GraphTab() {
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; node: GraphNode } | null>(null);
  const [activeStatuses, setActiveStatuses] = useState<Set<string>>(new Set(DEFAULT_ACTIVE));
  const svgRef = useRef<SVGSVGElement>(null);
  const hasLoaded = useRef(false);

  const loadGraph = useCallback(async (statuses: Set<string>) => {
    setLoading(true);
    try {
      const statusParam = statuses.size === ALL_STATUSES.length ? '' : `&status=${[...statuses].join(',')}`;
      const g = await api<GraphData>(`/tasks/graph?limit=200${statusParam}`);
      setGraphData(g);
    } catch {
      toast('Failed to load graph', true);
    } finally {
      setLoading(false);
    }
  }, []);

  const toggleStatus = useCallback((status: string) => {
    setActiveStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(status)) {
        if (next.size <= 1) return prev; // keep at least one
        next.delete(status);
      } else {
        next.add(status);
      }
      loadGraph(next);
      return next;
    });
  }, [loadGraph]);

  const showAll = useCallback(() => {
    const all = new Set(ALL_STATUSES as unknown as string[]);
    setActiveStatuses(all);
    loadGraph(all);
  }, [loadGraph]);

  const showActive = useCallback(() => {
    const active = new Set(DEFAULT_ACTIVE);
    setActiveStatuses(active);
    loadGraph(active);
  }, [loadGraph]);

  useEffect(() => {
    if (!hasLoaded.current) {
      hasLoaded.current = true;
      loadGraph(activeStatuses);
    }
  }, [loadGraph]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleMouseEnter = useCallback((e: React.MouseEvent, node: GraphNode) => {
    setTooltip({ x: e.clientX + 12, y: e.clientY + 12, node });
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    setTooltip((prev) => prev ? { ...prev, x: e.clientX + 12, y: e.clientY + 12 } : null);
  }, []);

  const handleMouseLeave = useCallback(() => {
    setTooltip(null);
  }, []);

  const nodes = graphData?.nodes ?? [];
  const edges = graphData?.edges ?? [];
  const layout = nodes.length > 0 ? layoutGraph(nodes, edges) : null;

  return (
    <div className="panel p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Task Graph DAG</h2>
        <div className="flex items-center gap-2 text-[11px] text-gray-500">
          {LEGEND.map((l) => (
            <button
              key={l.label}
              onClick={() => toggleStatus(l.label)}
              className={`flex items-center gap-1 px-1.5 py-0.5 rounded transition-opacity ${
                activeStatuses.has(l.label) ? 'opacity-100' : 'opacity-30'
              }`}
              title={activeStatuses.has(l.label) ? `Hide ${l.label}` : `Show ${l.label}`}
            >
              <span
                className={`w-2.5 h-2.5 inline-block ${l.shape === 'diamond' ? 'rounded-sm rotate-45' : 'rounded-full'}`}
                style={{ background: l.color }}
              />
              {l.label}
            </button>
          ))}
          <span className="text-gray-600 mx-1">|</span>
          <button onClick={showActive} className="btn-ghost text-[11px]" disabled={loading}>
            Active
          </button>
          <button onClick={showAll} className="btn-ghost text-[11px]" disabled={loading}>
            All
          </button>
          <button onClick={() => loadGraph(activeStatuses)} className="btn-ghost text-[11px]" disabled={loading}>
            Refresh
          </button>
        </div>
      </div>

      <div
        style={{
          overflow: 'auto',
          background: '#0a0a0f',
          borderRadius: 8,
          border: '1px solid #22222e',
        }}
      >
        {loading && !graphData ? (
          <div className="p-8">
            <Skeleton className="h-64" />
          </div>
        ) : nodes.length === 0 ? (
          <svg ref={svgRef} width={800} height={100}>
            <text x={20} y={40} fill="#6b7280" fontSize={12}>
              No tasks yet. Create tasks via MCP or the API to see the dependency graph.
            </text>
          </svg>
        ) : layout ? (
          <svg
            ref={svgRef}
            width={Math.max(layout.width, 800)}
            height={Math.max(layout.height, 400)}
          >
            <defs>
              <marker
                id="arrow"
                viewBox="0 0 10 10"
                refX={10}
                refY={5}
                markerWidth={6}
                markerHeight={6}
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="#4b5563" />
              </marker>
            </defs>

            {/* Edges */}
            {edges.map((e, i) => {
              const a = layout.pos.get(e.from);
              const b = layout.pos.get(e.to);
              if (!a || !b) return null;
              const edgeDx = b.x - a.x;
              const edgeDy = b.y - a.y;
              const len = Math.sqrt(edgeDx * edgeDx + edgeDy * edgeDy) || 1;
              const tx = b.x - (edgeDx / len) * 24;
              const ty = b.y - (edgeDy / len) * 24;
              return (
                <line
                  key={`edge-${i}`}
                  x1={a.x}
                  y1={a.y}
                  x2={tx}
                  y2={ty}
                  stroke="#2a2a38"
                  strokeWidth={1.5}
                  markerEnd="url(#arrow)"
                />
              );
            })}

            {/* Nodes */}
            {nodes.map((n) => {
              const p = layout.pos.get(n.id);
              if (!p) return null;
              const color = STATUS_COLOR[n.status] || '#6b7280';
              return (
                <g
                  key={n.id}
                  className="graph-node"
                  transform={`translate(${p.x},${p.y})`}
                  onMouseEnter={(e) => handleMouseEnter(e, n)}
                  onMouseMove={handleMouseMove}
                  onMouseLeave={handleMouseLeave}
                >
                  <circle
                    r={20}
                    fill={color}
                    fillOpacity={0.2}
                    stroke={color}
                    strokeWidth={2}
                  />
                  <text
                    textAnchor="middle"
                    dy={4}
                    fill="#e2e2ea"
                    fontSize={11}
                    fontWeight={600}
                  >
                    #{n.id}
                  </text>
                </g>
              );
            })}
          </svg>
        ) : null}
      </div>

      {/* Tooltip */}
      {tooltip && (
        <div
          className="tip"
          style={{
            display: 'block',
            left: tooltip.x,
            top: tooltip.y,
          }}
        >
          <div className="font-semibold mb-1">
            Task #{tooltip.node.id}{' '}
            <span className={`badge badge-${tooltip.node.priority || 'P2'}`}>
              {tooltip.node.priority || 'P2'}
            </span>
          </div>
          <div className="text-gray-400 mb-1">
            status: {tooltip.node.status} &middot; assignee:{' '}
            {tooltip.node.claimedBy || tooltip.node.assignedTo || '--'}
          </div>
          <div className="text-gray-200">
            {(tooltip.node.description || '').slice(0, 300)}
          </div>
        </div>
      )}
    </div>
  );
}
