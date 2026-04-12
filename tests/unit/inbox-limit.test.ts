import { describe, expect, test } from 'vitest';
import { parseInboxLimit } from '../../src/bus/broker.js';

describe('parseInboxLimit', () => {
  test('undefined → default 10000', () => {
    expect(parseInboxLimit(undefined)).toBe(10_000);
  });

  test('positive integer string → number', () => {
    expect(parseInboxLimit('1')).toBe(1);
    expect(parseInboxLimit('5')).toBe(5);
    expect(parseInboxLimit('10000')).toBe(10_000);
    expect(parseInboxLimit('999999')).toBe(999_999);
  });

  test('zero → throws', () => {
    expect(() => parseInboxLimit('0')).toThrow("invalid --inbox-limit value: '0'");
  });

  test('negative integer → throws', () => {
    expect(() => parseInboxLimit('-1')).toThrow("invalid --inbox-limit value: '-1'");
    expect(() => parseInboxLimit('-100')).toThrow();
  });

  test('non-integer → throws', () => {
    expect(() => parseInboxLimit('5.5')).toThrow("invalid --inbox-limit value: '5.5'");
    expect(() => parseInboxLimit('1.0')).toThrow();
  });

  test('non-numeric string → throws', () => {
    expect(() => parseInboxLimit('abc')).toThrow("invalid --inbox-limit value: 'abc'");
    expect(() => parseInboxLimit('')).toThrow();
    expect(() => parseInboxLimit('forever')).toThrow();
  });

  test('whitespace-trimmed positive integer → accepted', () => {
    // parseInt strips leading/trailing whitespace; our trim() check normalises it
    expect(parseInboxLimit(' 5 ')).toBe(5);
  });
});
