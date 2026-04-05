import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { createRequestContextMiddleware } from '../src/http/middleware/request-context.js';
import { createLogger } from '../src/logger.js';

function captureStream(): { write: (s: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { write: (s: string) => lines.push(s), lines };
}

function buildApp(logLines: string[]) {
  const log = createLogger({
    level: 'info',
    format: 'json',
    stream: { write: (s: string) => logLines.push(s) },
  });
  const app = new Hono();
  app.use('*', createRequestContextMiddleware(log));
  app.get('/ping', (c) => {
    const reqId = c.get('requestId');
    const l = c.get('logger');
    l.info('inside_handler');
    return c.json({ req_id: reqId });
  });
  app.get('/boom', () => {
    throw new Error('explode');
  });
  return app;
}

describe('request-context middleware', () => {
  it('generates a request id and echoes it in response header', async () => {
    const lines: string[] = [];
    const app = buildApp(lines);
    const res = await app.request('/ping');
    expect(res.status).toBe(200);
    const reqId = res.headers.get('X-Request-ID');
    expect(reqId).toBeTruthy();
    expect(reqId).toMatch(/^[0-9a-f-]{36}$/);
    const body = await res.json();
    expect(body.req_id).toBe(reqId);
  });

  it('honors a sane incoming X-Request-ID', async () => {
    const lines: string[] = [];
    const app = buildApp(lines);
    const res = await app.request('/ping', {
      headers: { 'X-Request-ID': 'trace-abc-123' },
    });
    expect(res.headers.get('X-Request-ID')).toBe('trace-abc-123');
  });

  it('rejects a garbage incoming X-Request-ID and generates a fresh one', async () => {
    const lines: string[] = [];
    const app = buildApp(lines);
    const res = await app.request('/ping', {
      headers: { 'X-Request-ID': 'has spaces & weird chars!!' },
    });
    expect(res.headers.get('X-Request-ID')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('logs one http_request line with method/path/status/duration', async () => {
    const lines: string[] = [];
    const app = buildApp(lines);
    await app.request('/ping');
    const httpLogs = lines
      .map((l) => JSON.parse(l.trimEnd()))
      .filter((r) => r.msg === 'http_request');
    expect(httpLogs.length).toBe(1);
    const rec = httpLogs[0];
    expect(rec.method).toBe('GET');
    expect(rec.path).toBe('/ping');
    expect(rec.status).toBe(200);
    expect(typeof rec.duration_ms).toBe('number');
    expect(typeof rec.req_id).toBe('string');
  });

  it('child logger from context carries req_id on every line', async () => {
    const lines: string[] = [];
    const app = buildApp(lines);
    const res = await app.request('/ping');
    const reqId = res.headers.get('X-Request-ID');
    const handlerLog = lines
      .map((l) => JSON.parse(l.trimEnd()))
      .find((r) => r.msg === 'inside_handler');
    expect(handlerLog).toBeTruthy();
    expect(handlerLog.req_id).toBe(reqId);
  });

  it('logs http_request even when handler throws', async () => {
    const lines: string[] = [];
    const app = buildApp(lines);
    // boom throws, Hono's default error handler will 500
    try {
      await app.request('/boom');
    } catch {
      // hono may rethrow in test mode; we just care about the log line
    }
    const httpLogs = lines
      .map((l) => JSON.parse(l.trimEnd()))
      .filter((r) => r.msg === 'http_request');
    expect(httpLogs.length).toBe(1);
    expect(httpLogs[0].status).toBe(500);
    expect(httpLogs[0].error).toBe('explode');
  });
});
