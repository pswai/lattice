import type { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getLogger } from '../logger.js';
import { checkListenerHealth } from '../services/event-emitter.js';

/** Maximum session age before it's considered abandoned (24 hours). */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** How often to sweep for expired sessions (5 minutes). */
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export interface McpSession {
  sessionId: string;
  transport: WebStandardStreamableHTTPServerTransport;
  server: McpServer;
  workspaceId: string;
  agentId: string;
  /** Set automatically by the registry. */
  lastActivityAt: number;
}

export type McpSessionInit = Omit<McpSession, 'lastActivityAt'>;

function agentKey(workspaceId: string, agentId: string): string {
  return `${workspaceId}:${agentId}`;
}

class SessionRegistry {
  /** sessionId → McpSession */
  private sessions = new Map<string, McpSession>();
  /** workspaceId:agentId → sessionId (reverse lookup for message routing) */
  private agentSessions = new Map<string, string>();
  /** workspaceId → Set<sessionId> (for broadcast push) */
  private workspaceSessions = new Map<string, Set<string>>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  registerSession(init: McpSessionInit): void {
    const session: McpSession = { ...init, lastActivityAt: Date.now() };

    // Close displaced session for the same agent (if any)
    const key = agentKey(session.workspaceId, session.agentId);
    const existingSessionId = this.agentSessions.get(key);
    if (existingSessionId && existingSessionId !== session.sessionId) {
      const existing = this.sessions.get(existingSessionId);
      if (existing) {
        existing.server.close().catch(() => {});
        this.sessions.delete(existingSessionId);
        getLogger().info('mcp_session_displaced', {
          oldSessionId: existingSessionId,
          newSessionId: session.sessionId,
          agentId: session.agentId,
        });
      }
    }

    this.sessions.set(session.sessionId, session);
    this.agentSessions.set(key, session.sessionId);
    const wsSet = this.workspaceSessions.get(session.workspaceId) ?? new Set();
    wsSet.add(session.sessionId);
    this.workspaceSessions.set(session.workspaceId, wsSet);
    this.ensureSweep();
  }

  removeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      const key = agentKey(session.workspaceId, session.agentId);
      // Only remove reverse mapping if it still points to this session
      if (this.agentSessions.get(key) === sessionId) {
        this.agentSessions.delete(key);
      }
      const wsSet = this.workspaceSessions.get(session.workspaceId);
      if (wsSet) {
        wsSet.delete(sessionId);
        if (wsSet.size === 0) this.workspaceSessions.delete(session.workspaceId);
      }
      this.sessions.delete(sessionId);
    }
  }

  getSession(sessionId: string): McpSession | undefined {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivityAt = Date.now();
    }
    return session;
  }

  getSessionForAgent(workspaceId: string, agentId: string): McpSession | undefined {
    const sessionId = this.agentSessions.get(agentKey(workspaceId, agentId));
    if (!sessionId) return undefined;
    return this.sessions.get(sessionId);
  }

  /** Remap a session's agent identity. Used when an agent registers and
   *  receives a server-assigned ID, replacing the generic header-based ID. */
  remapAgent(sessionId: string, newAgentId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Remove old reverse mapping
    const oldKey = agentKey(session.workspaceId, session.agentId);
    if (this.agentSessions.get(oldKey) === sessionId) {
      this.agentSessions.delete(oldKey);
    }

    // Update session and add new reverse mapping
    session.agentId = newAgentId;
    this.agentSessions.set(agentKey(session.workspaceId, newAgentId), sessionId);
  }

  /** Find the session ID for a given MCP auth context (workspace + header agent ID). */
  findSessionByAuth(workspaceId: string, agentId: string): string | undefined {
    return this.agentSessions.get(agentKey(workspaceId, agentId));
  }

  /** Remove all sessions (for testing). */
  clear(): void {
    this.sessions.clear();
    this.agentSessions.clear();
    this.workspaceSessions.clear();
  }

  /** Get all active sessions for a workspace (for broadcast push). */
  getSessionsForWorkspace(workspaceId: string): McpSession[] {
    const sessionIds = this.workspaceSessions.get(workspaceId);
    if (!sessionIds) return [];
    const sessions: McpSession[] = [];
    for (const sid of sessionIds) {
      const s = this.sessions.get(sid);
      if (s) sessions.push(s);
    }
    return sessions;
  }

  get size(): number {
    return this.sessions.size;
  }

  /** Start the sweep timer if not already running. */
  private ensureSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    // Don't prevent process exit
    if (this.sweepTimer.unref) this.sweepTimer.unref();
  }

  /** Evict sessions that haven't been active within the TTL. */
  private sweep(): void {
    const now = Date.now();
    let evicted = 0;
    for (const [sessionId, session] of this.sessions) {
      if (now - session.lastActivityAt > SESSION_TTL_MS) {
        this.removeSession(sessionId);
        session.server.close().catch(() => {});
        evicted++;
      }
    }
    if (evicted > 0) {
      getLogger().info('mcp_session_sweep', { evicted, remaining: this.sessions.size });
    }
    // Monitor eventBus listener health during each sweep
    checkListenerHealth();

    // Stop sweeping when no sessions remain
    if (this.sessions.size === 0 && this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }
}

export const sessionRegistry = new SessionRegistry();
