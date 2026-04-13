import { describe, expect, test } from 'vitest';
import {
  loadGatingConfig,
  parseList,
  shouldEmit,
  type GatingConfig,
} from '../../src/sender-policy.js';

const mk = (policy: GatingConfig['policy'], allow: string[] = [], deny: string[] = []): GatingConfig => ({
  policy,
  allowlist: allow,
  denylist: deny,
});

describe('shouldEmit', () => {
  test('allowlist: sender in list → allow', () => {
    expect(shouldEmit(mk('allowlist', ['a', 'b']), 'a')).toEqual({ allow: true });
  });

  test('allowlist: sender not in list → deny', () => {
    const d = shouldEmit(mk('allowlist', ['a', 'b']), 'c');
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe('not_in_allowlist');
  });

  test('allowlist: empty list → deny any sender', () => {
    expect(shouldEmit(mk('allowlist', []), 'anyone').allow).toBe(false);
  });

  test('denylist: sender in list → deny', () => {
    const d = shouldEmit(mk('denylist', [], ['x']), 'x');
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toBe('in_denylist');
  });

  test('denylist: sender not in list → allow', () => {
    expect(shouldEmit(mk('denylist', [], ['x']), 'y')).toEqual({ allow: true });
  });

  test('workspace-trust: any sender → allow', () => {
    expect(shouldEmit(mk('workspace-trust'), 'anyone')).toEqual({ allow: true });
  });
});

describe('loadGatingConfig', () => {
  test('no env → workspace-trust default', () => {
    expect(loadGatingConfig({})).toEqual({
      policy: 'workspace-trust',
      allowlist: [],
      denylist: [],
    });
  });

  test('allowlist policy + list parses CSV', () => {
    const cfg = loadGatingConfig({
      LATTICE_CHANNEL_SENDER_POLICY: 'allowlist',
      LATTICE_CHANNEL_SENDER_ALLOWLIST: 'a, b ,c',
    });
    expect(cfg.policy).toBe('allowlist');
    expect(cfg.allowlist).toEqual(['a', 'b', 'c']);
  });

  test('unknown policy throws at load time', () => {
    expect(() =>
      loadGatingConfig({ LATTICE_CHANNEL_SENDER_POLICY: 'typo' }),
    ).toThrow(/LATTICE_CHANNEL_SENDER_POLICY/);
  });

  test('empty string policy → workspace-trust default', () => {
    expect(loadGatingConfig({ LATTICE_CHANNEL_SENDER_POLICY: '' }).policy).toBe('workspace-trust');
  });
});

describe('parseList', () => {
  test('undefined → []', () => {
    expect(parseList(undefined)).toEqual([]);
  });
  test('trims and drops empties', () => {
    expect(parseList('a,,b , c')).toEqual(['a', 'b', 'c']);
  });
});
