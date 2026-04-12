import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { reconnectDelayMs } from '../../src/backoff.js';

describe('reconnectDelayMs', () => {
  it('delays increase with attempt number (deterministic rand=0)', () => {
    const rand = () => 0; // no jitter
    const d0 = reconnectDelayMs(0, rand); // base = 500
    const d1 = reconnectDelayMs(1, rand); // base = 1000
    const d2 = reconnectDelayMs(2, rand); // base = 2000
    expect(d1).toBeGreaterThan(d0);
    expect(d2).toBeGreaterThan(d1);
  });

  it('base is capped at 10 000 ms regardless of attempt number', () => {
    const rand = () => 0; // no jitter, isolate base
    const highAttempt = reconnectDelayMs(20, rand);
    expect(highAttempt).toBe(10_000); // base capped; jitter is 0
  });

  it('jitter spans 0–20 000 ms at steady-state (rand at extremes)', () => {
    const base = reconnectDelayMs(20, () => 0);   // min: base + 0 jitter
    const peak = reconnectDelayMs(20, () => 1);   // max: base + 20000 jitter
    expect(peak - base).toBeCloseTo(20_000, 0);
  });

  it('total spread at steady-state is 10–30 s (per RFC 0002)', () => {
    const min = reconnectDelayMs(20, () => 0);
    const max = reconnectDelayMs(20, () => 1);
    expect(min).toBeGreaterThanOrEqual(10_000);
    expect(max).toBeLessThanOrEqual(30_000);
  });

  it('first attempt (attempt=0) produces delay in 500–20 500 ms range', () => {
    const min = reconnectDelayMs(0, () => 0);
    const max = reconnectDelayMs(0, () => 1);
    expect(min).toBe(500);
    expect(max).toBeCloseTo(20_500, 0);
  });
});

describe('correlation_id uniqueness', () => {
  it('generates 100 000 unique UUIDs', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100_000; i++) {
      ids.add(randomUUID());
    }
    expect(ids.size).toBe(100_000);
  });
});
