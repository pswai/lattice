import { describe, expect, test } from 'vitest';
import {
  createPermissionMap,
  isVerdictPayload,
  loadPermissionConfig,
  resolveVerdict,
  type VerdictPayload,
} from '../../src/permission-relay.js';

describe('loadPermissionConfig', () => {
  test('relay unset → disabled', () => {
    expect(loadPermissionConfig({})).toEqual({ enabled: false });
  });

  test('relay=on requires approver', () => {
    expect(() =>
      loadPermissionConfig({ LATTICE_CHANNEL_PERMISSION_RELAY: 'on' }),
    ).toThrow(/APPROVER/);
  });

  test('relay=on + approver → enabled with default 30s', () => {
    expect(
      loadPermissionConfig({
        LATTICE_CHANNEL_PERMISSION_RELAY: 'on',
        LATTICE_CHANNEL_PERMISSION_APPROVER: 'agent-supervisor',
      }),
    ).toEqual({ enabled: true, approver: 'agent-supervisor', timeoutMs: 30_000 });
  });

  test('custom timeout honored', () => {
    const c = loadPermissionConfig({
      LATTICE_CHANNEL_PERMISSION_RELAY: 'on',
      LATTICE_CHANNEL_PERMISSION_APPROVER: 'a',
      LATTICE_CHANNEL_PERMISSION_TIMEOUT_MS: '500',
    });
    expect(c).toEqual({ enabled: true, approver: 'a', timeoutMs: 500 });
  });

  test('invalid timeout → throws', () => {
    expect(() =>
      loadPermissionConfig({
        LATTICE_CHANNEL_PERMISSION_RELAY: 'on',
        LATTICE_CHANNEL_PERMISSION_APPROVER: 'a',
        LATTICE_CHANNEL_PERMISSION_TIMEOUT_MS: '0',
      }),
    ).toThrow(/positive/);
  });
});

describe('isVerdictPayload', () => {
  test('valid verdict shape', () => {
    expect(
      isVerdictPayload({ kind: 'channel.permission_verdict', request_id: 'r1', verdict: 'allow' }),
    ).toBe(true);
  });

  test('rejects wrong kind', () => {
    expect(
      isVerdictPayload({ kind: 'channel.permission_request', request_id: 'r1', verdict: 'allow' }),
    ).toBe(false);
  });

  test('rejects bad verdict value', () => {
    expect(
      isVerdictPayload({ kind: 'channel.permission_verdict', request_id: 'r1', verdict: 'maybe' }),
    ).toBe(false);
  });

  test('rejects non-object payloads', () => {
    expect(isVerdictPayload(null)).toBe(false);
    expect(isVerdictPayload('string')).toBe(false);
  });
});

describe('resolveVerdict', () => {
  const approver = 'agent-supervisor';
  const verdict = (v: 'allow' | 'deny' = 'allow'): VerdictPayload => ({
    kind: 'channel.permission_verdict',
    request_id: 'r1',
    verdict: v,
  });

  test('allow path emits behavior=allow and consumes the entry', () => {
    const map = createPermissionMap();
    map.set('c1', { request_id: 'r1', expires_at: 10_000 });
    const r = resolveVerdict(map, verdict('allow'), 'c1', approver, approver, 5_000);
    expect(r.action).toBe('emit');
    if (r.action === 'emit') {
      expect(r.consumed.request_id).toBe('r1');
      expect(r.behavior).toBe('allow');
      expect(r.outcome).toBe('verdict_accepted');
    }
    expect(map.get('c1')).toBeUndefined();
  });

  test('deny path emits behavior=deny', () => {
    const map = createPermissionMap();
    map.set('c1', { request_id: 'r1', expires_at: 10_000 });
    const r = resolveVerdict(map, verdict('deny'), 'c1', approver, approver, 5_000);
    expect(r.action).toBe('emit');
    if (r.action === 'emit') expect(r.behavior).toBe('deny');
  });

  test('unauthorized sender drops, even with valid correlation', () => {
    const map = createPermissionMap();
    map.set('c1', { request_id: 'r1', expires_at: 10_000 });
    const r = resolveVerdict(map, verdict('allow'), 'c1', 'agent-intruder', approver, 5_000);
    expect(r).toEqual({
      action: 'drop',
      outcome: 'verdict_unauthorized',
      request_id: 'r1',
    });
    // Entry preserved so the legitimate verdict can still resolve.
    expect(map.get('c1')).toBeDefined();
  });

  test('expired entry drops as late_verdict', () => {
    const map = createPermissionMap();
    map.set('c1', { request_id: 'r1', expires_at: 1_000 });
    const r = resolveVerdict(map, verdict('allow'), 'c1', approver, approver, 5_000);
    expect(r.outcome).toBe('late_verdict');
  });

  test('unknown correlation drops as late_verdict', () => {
    const map = createPermissionMap();
    const r = resolveVerdict(map, verdict('allow'), 'unknown', approver, approver, 5_000);
    expect(r.outcome).toBe('late_verdict');
  });

  test('null correlation drops as late_verdict', () => {
    const map = createPermissionMap();
    const r = resolveVerdict(map, verdict('allow'), null, approver, approver, 5_000);
    expect(r.outcome).toBe('late_verdict');
  });

  test('second verdict for same correlation drops (first wins)', () => {
    const map = createPermissionMap();
    map.set('c1', { request_id: 'r1', expires_at: 10_000 });
    const first = resolveVerdict(map, verdict('allow'), 'c1', approver, approver, 5_000);
    expect(first.action).toBe('emit');
    const second = resolveVerdict(map, verdict('deny'), 'c1', approver, approver, 5_001);
    expect(second.outcome).toBe('late_verdict');
  });
});
