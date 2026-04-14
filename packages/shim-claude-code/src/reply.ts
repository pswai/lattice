// lattice_reply: look up an inbound bus message by its cursor and build a
// reply that targets the original sender with the inbound's correlation_id
// (minting a fresh one if the inbound had none).
//
// A local cache is needed because the broker's only retrieval op is the
// push stream; there is no "fetch message by cursor" wire op (and RFC 0002
// locks the surface to five ops). The shim therefore records what it just
// emitted so lattice_reply can resolve a cursor without a round-trip.

import { randomUUID } from 'node:crypto';
import { LruCache } from '../../sdk-ts/dist/lru.js';

export type InboundRef = {
  from: string;
  correlation_id: string | null;
};

// 1000 entries is plenty for a single agent's in-flight inbound set.
// Eviction just means older messages can no longer be replied to via this
// tool; the model can fall back to lattice_send_message with a manual
// correlation_id (surfaced in the tool's error hint).
export type InboundCache = LruCache<number, InboundRef>;
export const createInboundCache = (maxSize = 1000): InboundCache =>
  new LruCache<number, InboundRef>(maxSize);

export type ReplyArgs = {
  to: string;
  type: 'direct';
  payload: unknown;
  correlation_id: string;
};

export type ReplyResult =
  | { ok: true; args: ReplyArgs }
  | { ok: false; error: 'unknown_message_id'; to_message_id: number };

export function buildReply(
  cache: InboundCache,
  to_message_id: number,
  payload: unknown,
): ReplyResult {
  const inbound = cache.get(to_message_id);
  if (!inbound) {
    return { ok: false, error: 'unknown_message_id', to_message_id };
  }
  return {
    ok: true,
    args: {
      to: inbound.from,
      type: 'direct',
      payload,
      correlation_id: inbound.correlation_id ?? randomUUID(),
    },
  };
}
