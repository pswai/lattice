export interface Agent {
  id: string;
  status: 'online' | 'busy' | 'offline';
  capabilities: string[];
  lastHeartbeat: string | null;
  metadata?: Record<string, unknown>;
}

export interface Task {
  id: number;
  description: string;
  status: 'open' | 'claimed' | 'completed' | 'escalated' | 'abandoned';
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  claimedBy?: string;
  assignedTo?: string;
  createdAt: string;
  dependsOn?: number[];
  version: number;
  result?: string;
}

export interface LatticeEvent {
  id: number;
  eventType: string;
  message: string;
  createdBy: string;
  createdAt: string;
  tags?: string[];
}

export interface Artifact {
  key: string;
  contentType: string;
  size: number;
  createdBy: string;
  createdAt: string;
  content?: string;
}

export interface Playbook {
  name: string;
  description: string;
  tasks: unknown[];
  createdBy: string;
}

export interface AuditEntry {
  id: number;
  action: string;
  actor: string;
  resource?: string;
  ip?: string;
  createdAt: string;
}

export interface ApiKey {
  id: string;
  label?: string;
  scope: 'admin' | 'write' | 'read';
  createdAt: string;
  lastUsedAt?: string;
  expiresAt?: string;
  revokedAt?: string;
}

export interface Analytics {
  tasks: { total: number; completion_rate: number };
  events: { total: number };
  agents: { total: number };
}

export interface DashboardSnapshot {
  workspace?: { id: string; name: string };
  agents: Agent[];
  tasks: Task[];
  recentEvents: LatticeEvent[];
  analytics: Analytics;
  auditLog: AuditEntry[];
  apiKeys: ApiKey[];
}

export interface GraphData {
  nodes: (Task & { x?: number; y?: number })[];
  edges: { from: number; to: number }[];
}
