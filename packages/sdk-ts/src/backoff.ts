// Exponential backoff with full jitter for broker reconnects.
// At steady state (attempt ≥ 5): base is capped at 10s, jitter adds 0–20s.
// Spread: 10–30s per RFC 0002 §Reconnect policy.

const BASE_MS = 500;
const CAP_BASE_MS = 10_000;
const JITTER_RANGE_MS = 20_000;

/**
 * Compute reconnect delay for the given attempt number (0-indexed).
 * @param attempt  0 = first reconnect attempt
 * @param randFn   Random source; defaults to Math.random (injectable for tests)
 */
export function reconnectDelayMs(attempt: number, randFn: () => number = Math.random): number {
  const base = Math.min(CAP_BASE_MS, BASE_MS * Math.pow(2, attempt));
  const jitter = randFn() * JITTER_RANGE_MS;
  return base + jitter;
}
