/**
 * TUI color theme and visual constants.
 */

export const colors = {
  // Status
  online: '#22c55e',    // green-500
  offline: '#6b7280',   // gray-500
  busy: '#f59e0b',      // amber-500

  // Priority
  p0: '#ef4444',        // red-500
  p1: '#f97316',        // orange-500
  p2: '#3b82f6',        // blue-500
  p3: '#6b7280',        // gray-500

  // Task status
  open: '#3b82f6',      // blue-500
  claimed: '#f59e0b',   // amber-500
  completed: '#22c55e', // green-500
  escalated: '#ef4444', // red-500
  abandoned: '#6b7280', // gray-500

  // Event types
  LEARNING: '#22c55e',
  BROADCAST: '#3b82f6',
  ESCALATION: '#f59e0b',
  ERROR: '#ef4444',
  TASK_UPDATE: '#8b5cf6',

  // Chrome
  accent: '#8b5cf6',    // violet-500
  border: '#374151',    // gray-700
  borderFocus: '#8b5cf6',
  dim: '#6b7280',       // gray-500
  text: '#e5e7eb',      // gray-200
  textBright: '#f9fafb', // gray-50
  bg: '',               // terminal default
  headerBg: '#1f2937',  // gray-800

  // Workflow
  running: '#3b82f6',
  failed: '#ef4444',
} as const;

export const symbols = {
  selected: '\u25b8',      // ▸
  unselected: ' ',
  online: '\u25cf',        // ●
  offline: '\u25cb',       // ○
  busy: '\u25d0',          // ◐
  check: '\u2713',         // ✓
  cross: '\u2717',         // ✗
  arrow: '\u2192',         // →
  dot: '\u00b7',           // ·
  dash: '\u2500',          // ─
  vertLine: '\u2502',      // │
  topLeft: '\u250c',       // ┌
  topRight: '\u2510',      // ┐
  bottomLeft: '\u2514',    // └
  bottomRight: '\u2518',   // ┘
  teeRight: '\u251c',      // ├
  teeLeft: '\u2524',       // ┤
  teeDown: '\u252c',       // ┬
  teeUp: '\u2534',         // ┴
  ellipsis: '\u2026',      // …
  block: '\u2588',         // █
  blockLight: '\u2591',    // ░
  blockMed: '\u2592',      // ▒
} as const;

export const priorityLabel: Record<string, string> = {
  P0: 'P0',
  P1: 'P1',
  P2: 'P2',
  P3: 'P3',
};

export function statusSymbol(status: string): string {
  switch (status) {
    case 'online': return symbols.online;
    case 'offline': return symbols.offline;
    case 'busy': return symbols.busy;
    default: return ' ';
  }
}

export function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return timeUntil(iso);
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function timeUntil(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff < 0) return timeAgo(iso);
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `in ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  const days = Math.floor(hours / 24);
  return `in ${days}d`;
}

export function truncate(s: string | undefined | null, maxLen: number): string {
  if (!s) return '';
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + symbols.ellipsis;
}
