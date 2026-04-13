// Permission relay: Claude Code's implementation of mid-task interrupt.
// When CC is about to call a tool, it emits a permission_request notification
// to the shim; the shim forwards it to a configured approver agent as a
// direct bus message, waits for a verdict tied by correlation_id, and hands
// the verdict back to CC. If nothing arrives within the timeout, CC's
// terminal dialog resolves.
//
// Wire encoding: RFC 0004 §3 names the message "type" as
// 'channel.permission_request' / 'channel.permission_verdict'. The broker's
// wire `type` field is locked to {direct,broadcast,event} per RFC 0002, so
// the discriminator lives in `payload.kind`. This is the concrete encoding;
// the RFC's prose reflects the same intent.

import { z } from 'zod';
import { LruCache } from '../../sdk-ts/dist/lru.js';

// Wire-protocol constants — exported so tests and call sites don't restate
// the literal strings (and don't drift from the RFC).
export const PERMISSION_KIND = {
  REQUEST: 'channel.permission_request',
  VERDICT: 'channel.permission_verdict',
} as const;

export const PERMISSION_METHOD = {
  REQUEST: 'notifications/claude/channel/permission_request',
  RESPONSE: 'notifications/claude/channel/permission',
} as const;

export type PermissionConfig =
  | { enabled: false }
  | { enabled: true; approver: string; timeoutMs: number };

export function loadPermissionConfig(env: NodeJS.ProcessEnv): PermissionConfig {
  const relay = env.LATTICE_CHANNEL_PERMISSION_RELAY?.trim().toLowerCase();
  if (relay !== 'on') return { enabled: false };

  const approver = env.LATTICE_CHANNEL_PERMISSION_APPROVER?.trim();
  if (!approver) {
    throw new Error(
      'LATTICE_CHANNEL_PERMISSION_RELAY=on requires LATTICE_CHANNEL_PERMISSION_APPROVER to name the approver agent',
    );
  }

  const rawTimeout = env.LATTICE_CHANNEL_PERMISSION_TIMEOUT_MS?.trim();
  const timeoutMs = rawTimeout ? Number(rawTimeout) : 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      `LATTICE_CHANNEL_PERMISSION_TIMEOUT_MS=${rawTimeout!}: must be a positive number`,
    );
  }

  return { enabled: true, approver, timeoutMs };
}

// Correlation map: in-flight permission requests keyed by correlation_id.
// No persistence — on shim crash this is gone, so replayed verdicts from
// the broker match nothing and drop as late_verdict. That is the RFC's
// "replay: false" property expressed via the miss path.
//
// `timer` is the cleanup setTimeout handle; on accept we clear it so we
// don't keep a dead closure around for the rest of the timeout window.
export type PendingRequest = {
  request_id: string;
  expires_at: number;
  timer?: NodeJS.Timeout;
};
export type PermissionMap = LruCache<string, PendingRequest>;
export const createPermissionMap = (maxSize = 1000): PermissionMap =>
  new LruCache<string, PendingRequest>(maxSize);

export type RequestPayload = {
  kind: typeof PERMISSION_KIND.REQUEST;
  request_id: string;
  tool_name: string;
  description?: string;
  input_preview?: unknown;
};

export type VerdictPayload = {
  kind: typeof PERMISSION_KIND.VERDICT;
  request_id: string;
  verdict: 'allow' | 'deny';
};

export function isVerdictPayload(payload: unknown): payload is VerdictPayload {
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as Record<string, unknown>;
  return (
    p.kind === PERMISSION_KIND.VERDICT &&
    typeof p.request_id === 'string' &&
    (p.verdict === 'allow' || p.verdict === 'deny')
  );
}

// Zod schema for the inbound MCP notification CC sends to the shim. Lives
// here next to the RequestPayload type so the wire contract is in one file.
export const PermissionRequestNotificationSchema = z.object({
  method: z.literal(PERMISSION_METHOD.REQUEST),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string().optional(),
    input_preview: z.unknown().optional(),
  }),
});

export type VerdictResolution =
  | {
      action: 'emit';
      consumed: PendingRequest;
      behavior: 'allow' | 'deny';
      outcome: 'verdict_accepted';
    }
  | {
      action: 'drop';
      outcome: 'verdict_unauthorized' | 'late_verdict';
      request_id?: string;
    };

// Pure verdict resolution. Mutates the map on accept (so a second verdict
// for the same correlation can't double-fire); returns the consumed entry
// so the caller can clear its cleanup timer.
export function resolveVerdict(
  map: PermissionMap,
  payload: VerdictPayload,
  correlation_id: string | null,
  from: string,
  approver: string,
  now: number,
): VerdictResolution {
  // Unauthorized sender is checked first so a forged verdict (even with a
  // real correlation_id) never counts toward resolution.
  if (from !== approver) {
    return { action: 'drop', outcome: 'verdict_unauthorized', request_id: payload.request_id };
  }
  if (correlation_id === null) {
    return { action: 'drop', outcome: 'late_verdict', request_id: payload.request_id };
  }
  const entry = map.get(correlation_id);
  if (!entry || entry.expires_at <= now) {
    return { action: 'drop', outcome: 'late_verdict', request_id: payload.request_id };
  }
  map.delete(correlation_id);
  return {
    action: 'emit',
    consumed: entry,
    behavior: payload.verdict,
    outcome: 'verdict_accepted',
  };
}
