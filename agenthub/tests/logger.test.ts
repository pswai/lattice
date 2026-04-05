import { describe, it, expect } from 'vitest';
import { createLogger, redactSecrets } from '../src/logger.js';

function captureStream(): { write: (s: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { write: (s: string) => lines.push(s), lines };
}

describe('logger', () => {
  it('emits JSON with ts, level, msg, and bound fields', () => {
    const stream = captureStream();
    const log = createLogger({ level: 'debug', format: 'json', stream });
    log.info('hello', { x: 1 });
    expect(stream.lines.length).toBe(1);
    const rec = JSON.parse(stream.lines[0].trimEnd());
    expect(rec.level).toBe('info');
    expect(rec.msg).toBe('hello');
    expect(rec.x).toBe(1);
    expect(typeof rec.ts).toBe('string');
    expect(rec.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('respects level threshold', () => {
    const stream = captureStream();
    const log = createLogger({ level: 'warn', format: 'json', stream });
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(stream.lines.length).toBe(2);
    expect(JSON.parse(stream.lines[0]).level).toBe('warn');
    expect(JSON.parse(stream.lines[1]).level).toBe('error');
  });

  it('silent level emits nothing', () => {
    const stream = captureStream();
    const log = createLogger({ level: 'silent', format: 'json', stream });
    log.error('boom');
    expect(stream.lines.length).toBe(0);
  });

  it('child logger inherits and extends fields', () => {
    const stream = captureStream();
    const log = createLogger({
      level: 'info',
      format: 'json',
      stream,
      fields: { app: 'agenthub' },
    });
    const child = log.child({ req_id: 'abc' });
    child.info('ok', { extra: true });
    const rec = JSON.parse(stream.lines[0].trimEnd());
    expect(rec.app).toBe('agenthub');
    expect(rec.req_id).toBe('abc');
    expect(rec.extra).toBe(true);
  });

  it('request fields override child fields (last-write-wins)', () => {
    const stream = captureStream();
    const log = createLogger({
      level: 'info',
      format: 'json',
      stream,
      fields: { team_id: 'a' },
    });
    log.info('x', { team_id: 'b' });
    expect(JSON.parse(stream.lines[0]).team_id).toBe('b');
  });

  it('redacts AgentHub API keys from log lines', () => {
    const stream = captureStream();
    const log = createLogger({ level: 'info', format: 'json', stream });
    log.info('request', { auth: 'ah_' + 'a'.repeat(48) });
    expect(stream.lines[0]).toContain('[REDACTED]');
    expect(stream.lines[0]).not.toContain('ah_' + 'a'.repeat(48));
  });

  it('redacts common secret formats', () => {
    expect(redactSecrets('Bearer abc123abc123abc123abc123abc123abc123abc123')).toContain('[REDACTED]');
    expect(redactSecrets('key=sk-' + 'x'.repeat(40))).toContain('[REDACTED]');
    expect(redactSecrets('AKIAABCDEFGHIJKLMNOP use me')).toContain('[REDACTED]');
    expect(redactSecrets('AIza' + 'x'.repeat(35))).toContain('[REDACTED]');
  });

  it('pretty format includes level word and msg', () => {
    const stream = captureStream();
    const log = createLogger({ level: 'info', format: 'pretty', stream });
    log.info('hello world', { k: 'v' });
    // Strip ANSI escape codes for assertions
    const plain = stream.lines[0].replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toContain('INFO');
    expect(plain).toContain('hello world');
    expect(plain).toContain('k=v');
  });
});
