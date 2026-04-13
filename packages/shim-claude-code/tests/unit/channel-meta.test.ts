import { describe, expect, test } from 'vitest';
import { buildChannelMeta } from '../../src/channel-meta.js';
import type { MessageFrame } from '../../../sdk-ts/dist/index.js';

const base = (over: Partial<MessageFrame> = {}): MessageFrame => ({
  cursor: 1,
  created_at: 1700000000000,
  from: 'agent-a',
  to: 'agent-b',
  topic: null,
  type: 'direct',
  payload: {},
  idempotency_key: null,
  correlation_id: null,
  ...over,
});

describe('buildChannelMeta', () => {
  test('populates required fields', () => {
    const meta = buildChannelMeta(base());
    expect(meta).toMatchObject({
      from: 'agent-a',
      type: 'direct',
      cursor: '1',
      created_at: '1700000000000',
    });
    expect(meta).not.toHaveProperty('topic');
    expect(meta).not.toHaveProperty('correlation_id');
  });

  test('includes optional fields when present', () => {
    const meta = buildChannelMeta(
      base({ topic: 'alerts', idempotency_key: 'k1', correlation_id: 'c1' }),
    );
    expect(meta.topic).toBe('alerts');
    expect(meta.idempotency_key).toBe('k1');
    expect(meta.correlation_id).toBe('c1');
  });

  test('drops null/undefined values', () => {
    const meta = buildChannelMeta(base({ correlation_id: null, topic: null }));
    expect(Object.keys(meta).sort()).toEqual(['created_at', 'cursor', 'from', 'type']);
  });
});
