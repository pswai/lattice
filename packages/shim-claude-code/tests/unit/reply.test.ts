import { describe, expect, test } from 'vitest';
import { buildReply, createInboundCache } from '../../src/reply.js';

describe('inbound cache (LruCache<number, InboundRef>)', () => {
  test('set + get round-trip', () => {
    const c = createInboundCache();
    c.set(42, { from: 'agent-a', correlation_id: 'c1' });
    expect(c.get(42)).toEqual({ from: 'agent-a', correlation_id: 'c1' });
  });

  test('evicts oldest at capacity', () => {
    const c = createInboundCache(3);
    c.set(1, { from: 'a', correlation_id: null });
    c.set(2, { from: 'b', correlation_id: null });
    c.set(3, { from: 'c', correlation_id: null });
    c.set(4, { from: 'd', correlation_id: null });
    expect(c.get(1)).toBeUndefined();
    expect(c.get(4)).toBeDefined();
    expect(c.size).toBe(3);
  });

  test('re-setting refreshes position', () => {
    const c = createInboundCache(3);
    c.set(1, { from: 'a', correlation_id: null });
    c.set(2, { from: 'b', correlation_id: null });
    c.set(3, { from: 'c', correlation_id: null });
    c.set(1, { from: 'a', correlation_id: null }); // refresh 1 → now newest
    c.set(4, { from: 'd', correlation_id: null }); // should evict 2, not 1
    expect(c.get(1)).toBeDefined();
    expect(c.get(2)).toBeUndefined();
  });
});

describe('buildReply', () => {
  test('unknown id returns structured error, does not throw', () => {
    const c = createInboundCache();
    const r = buildReply(c, 99, { hello: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe('unknown_message_id');
      expect(r.to_message_id).toBe(99);
    }
  });

  test('carries inbound.from as to and inbound.correlation_id', () => {
    const c = createInboundCache();
    c.set(42, { from: 'agent-a', correlation_id: 'c1' });
    const r = buildReply(c, 42, { ack: true });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args.to).toBe('agent-a');
      expect(r.args.type).toBe('direct');
      expect(r.args.correlation_id).toBe('c1');
      expect(r.args.payload).toEqual({ ack: true });
    }
  });

  test('mints correlation_id when inbound had none', () => {
    const c = createInboundCache();
    c.set(42, { from: 'agent-a', correlation_id: null });
    const r = buildReply(c, 42, 'string-payload');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args.correlation_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(r.args.payload).toBe('string-payload');
    }
  });
});
