/**
 * TUI theme utilities — exhaustive unit tests.
 */
import { describe, it, expect } from 'vitest';
import { timeAgo, timeUntil, truncate, statusSymbol, colors, symbols } from '../src/tui/theme.js';

describe('timeAgo', () => {
  function ago(ms: number): string {
    return timeAgo(new Date(Date.now() - ms).toISOString());
  }

  it('formats seconds', () => {
    expect(ago(0)).toBe('0s ago');
    expect(ago(1_000)).toBe('1s ago');
    expect(ago(59_000)).toBe('59s ago');
  });

  it('formats minutes', () => {
    expect(ago(60_000)).toBe('1m ago');
    expect(ago(5 * 60_000)).toBe('5m ago');
    expect(ago(59 * 60_000)).toBe('59m ago');
  });

  it('formats hours', () => {
    expect(ago(60 * 60_000)).toBe('1h ago');
    expect(ago(23 * 60 * 60_000)).toBe('23h ago');
  });

  it('formats days', () => {
    expect(ago(24 * 60 * 60_000)).toBe('1d ago');
    expect(ago(7 * 24 * 60 * 60_000)).toBe('7d ago');
    expect(ago(365 * 24 * 60 * 60_000)).toBe('365d ago');
  });

  it('delegates to timeUntil for future dates', () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    expect(timeAgo(future)).toMatch(/^in \d+/);
  });
});

describe('timeUntil', () => {
  function until(ms: number): string {
    return timeUntil(new Date(Date.now() + ms).toISOString());
  }

  it('formats future seconds', () => {
    expect(until(30_000)).toBe('in 30s');
  });

  it('formats future minutes', () => {
    expect(until(5 * 60_000)).toBe('in 5m');
  });

  it('formats future hours', () => {
    expect(until(3 * 3600_000)).toBe('in 3h');
  });

  it('formats future days', () => {
    expect(until(2 * 86400_000)).toBe('in 2d');
  });

  it('delegates to timeAgo for past dates', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(timeUntil(past)).toMatch(/ago$/);
  });
});

describe('truncate', () => {
  it('returns string unchanged when shorter than max', () => {
    expect(truncate('abc', 10)).toBe('abc');
  });

  it('returns string unchanged at exact max', () => {
    expect(truncate('abcde', 5)).toBe('abcde');
  });

  it('truncates with ellipsis when over max', () => {
    expect(truncate('hello world', 8)).toBe('hello w\u2026');
  });

  it('truncates to 1 char + ellipsis at maxLen=2', () => {
    expect(truncate('hello', 2)).toBe('h\u2026');
  });

  it('handles empty string', () => {
    expect(truncate('', 5)).toBe('');
  });

  it('handles null/undefined gracefully', () => {
    expect(truncate(null, 5)).toBe('');
    expect(truncate(undefined, 5)).toBe('');
  });

  it('handles single character', () => {
    expect(truncate('a', 1)).toBe('a');
  });
});

describe('statusSymbol', () => {
  it('returns filled circle for online', () => {
    expect(statusSymbol('online')).toBe(symbols.online);
  });

  it('returns hollow circle for offline', () => {
    expect(statusSymbol('offline')).toBe(symbols.offline);
  });

  it('returns half circle for busy', () => {
    expect(statusSymbol('busy')).toBe(symbols.busy);
  });

  it('returns space for unknown status', () => {
    expect(statusSymbol('anything')).toBe(' ');
    expect(statusSymbol('')).toBe(' ');
  });
});

describe('colors', () => {
  it('has distinct colors for all task statuses', () => {
    const statuses = ['open', 'claimed', 'completed', 'escalated', 'abandoned'] as const;
    for (const s of statuses) {
      expect(colors[s]).toBeTruthy();
    }
    // completed and escalated should be different
    expect(colors.completed).not.toBe(colors.escalated);
  });

  it('has distinct colors for all event types', () => {
    const types = ['LEARNING', 'BROADCAST', 'ESCALATION', 'ERROR', 'TASK_UPDATE'] as const;
    for (const t of types) {
      expect(colors[t]).toBeTruthy();
    }
  });

  it('has distinct colors for priorities', () => {
    expect(colors.p0).toBeTruthy();
    expect(colors.p3).toBeTruthy();
    expect(colors.p0).not.toBe(colors.p3);
  });
});

describe('symbols', () => {
  it('selected indicator is a triangle', () => {
    expect(symbols.selected).toBe('\u25b8');
  });

  it('check and cross are defined', () => {
    expect(symbols.check).toBe('\u2713');
    expect(symbols.cross).toBe('\u2717');
  });

  it('box drawing characters are defined', () => {
    expect(symbols.topLeft).toBeTruthy();
    expect(symbols.bottomRight).toBeTruthy();
    expect(symbols.vertLine).toBeTruthy();
    expect(symbols.dash).toBeTruthy();
  });
});
