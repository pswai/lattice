import type { MessageFrame } from '../../sdk-ts/dist/index.js';

// Meta attributes on the <channel> tag. Claude Code silently drops keys that
// aren't valid identifiers (no hyphens, etc.), so we filter preemptively.
const VALID_META_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function buildChannelMeta(msg: MessageFrame): Record<string, string> {
  const raw: Record<string, string | null | undefined> = {
    from: msg.from,
    type: msg.type,
    cursor: String(msg.cursor),
    created_at: String(msg.created_at),
    topic: msg.topic,
    idempotency_key: msg.idempotency_key,
    correlation_id: msg.correlation_id,
  };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined || v === null) continue;
    if (!VALID_META_KEY.test(k)) continue;
    out[k] = v;
  }
  return out;
}
