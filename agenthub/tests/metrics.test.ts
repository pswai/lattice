import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  PROMETHEUS_CONTENT_TYPE,
} from '../src/metrics.js';
import { createMetricsMiddleware, normalizeRoute } from '../src/http/middleware/metrics.js';

describe('Counter', () => {
  it('increments and tracks label dimensions', () => {
    const c = new Counter({
      name: 'test_req_total',
      help: 'test counter',
      labelNames: ['method'],
    });
    c.inc({ method: 'GET' });
    c.inc({ method: 'GET' });
    c.inc({ method: 'POST' });
    expect(c.get({ method: 'GET' })).toBe(2);
    expect(c.get({ method: 'POST' })).toBe(1);
    expect(c.get({ method: 'DELETE' })).toBe(0);
  });

  it('supports custom delta', () => {
    const c = new Counter({ name: 'x', help: 'x' });
    c.inc({}, 5);
    c.inc({}, 3);
    expect(c.get()).toBe(8);
  });

  it('renders prometheus text format with HELP and TYPE', () => {
    const c = new Counter({
      name: 'my_counter',
      help: 'a test counter',
      labelNames: ['kind'],
    });
    c.inc({ kind: 'apple' }, 3);
    const out = c.render();
    expect(out).toContain('# HELP my_counter a test counter');
    expect(out).toContain('# TYPE my_counter counter');
    expect(out).toContain('my_counter{kind="apple"} 3');
  });

  it('emits a zero sample when unused', () => {
    const c = new Counter({ name: 'unused', help: 'nothing' });
    const out = c.render();
    expect(out).toContain('unused 0');
  });
});

describe('Gauge', () => {
  it('set / inc / get', () => {
    const g = new Gauge({ name: 'g', help: 'g', labelNames: ['t'] });
    g.set({ t: 'a' }, 5);
    expect(g.get({ t: 'a' })).toBe(5);
    g.inc({ t: 'a' }, 2);
    expect(g.get({ t: 'a' })).toBe(7);
    g.set({ t: 'a' }, 0);
    expect(g.get({ t: 'a' })).toBe(0);
  });

  it('renders gauge type', () => {
    const g = new Gauge({ name: 'mygauge', help: 'help', labelNames: [] });
    g.set(42);
    const out = g.render();
    expect(out).toContain('# TYPE mygauge gauge');
    expect(out).toContain('mygauge 42');
  });
});

describe('Histogram', () => {
  it('assigns values to cumulative buckets', () => {
    const h = new Histogram({
      name: 'h',
      help: 'h',
      labelNames: ['route'],
      buckets: [5, 10, 25, 50, 100],
    });
    h.observe({ route: '/x' }, 3);
    h.observe({ route: '/x' }, 12);
    h.observe({ route: '/x' }, 80);
    const counts = h.getBucketCounts({ route: '/x' })!;
    // cumulative: [<=5]=1, [<=10]=1, [<=25]=2, [<=50]=2, [<=100]=3
    expect(counts).toEqual([1, 1, 2, 2, 3]);
    expect(h.getCount({ route: '/x' })).toBe(3);
    expect(h.getSum({ route: '/x' })).toBe(95);
  });

  it('renders _bucket, _sum, _count with +Inf bucket', () => {
    const h = new Histogram({
      name: 'lat',
      help: 'lat',
      labelNames: ['r'],
      buckets: [10, 100],
    });
    h.observe({ r: '/a' }, 5);
    h.observe({ r: '/a' }, 150);
    const out = h.render();
    expect(out).toContain('# TYPE lat histogram');
    expect(out).toContain('lat_bucket{r="/a",le="10"} 1');
    expect(out).toContain('lat_bucket{r="/a",le="100"} 1');
    expect(out).toContain('lat_bucket{r="/a",le="+Inf"} 2');
    expect(out).toContain('lat_sum{r="/a"} 155');
    expect(out).toContain('lat_count{r="/a"} 2');
  });
});

describe('Registry', () => {
  it('registers and renders all metrics', () => {
    const r = new Registry();
    const c = r.register(new Counter({ name: 'a_total', help: 'a' }));
    r.register(new Gauge({ name: 'b_gauge', help: 'b' }));
    c.inc();
    const out = r.render();
    expect(out).toContain('# TYPE a_total counter');
    expect(out).toContain('# TYPE b_gauge gauge');
    expect(out.endsWith('\n')).toBe(true);
  });

  it('prevents duplicate registration', () => {
    const r = new Registry();
    r.register(new Counter({ name: 'dup', help: 'x' }));
    expect(() =>
      r.register(new Counter({ name: 'dup', help: 'y' })),
    ).toThrow(/already registered/);
  });
});

describe('label escaping', () => {
  it('escapes quotes, backslashes, newlines in label values', () => {
    const c = new Counter({
      name: 'e',
      help: 'e',
      labelNames: ['x'],
    });
    c.inc({ x: 'hello "world"\\ok\nbye' });
    const out = c.render();
    expect(out).toContain('hello \\"world\\"\\\\ok\\nbye');
  });
});

describe('content-type constant', () => {
  it('is the standard prometheus text format', () => {
    expect(PROMETHEUS_CONTENT_TYPE).toBe('text/plain; version=0.0.4; charset=utf-8');
  });
});

describe('normalizeRoute', () => {
  it('collapses numeric IDs', () => {
    expect(normalizeRoute('/tasks/123')).toBe('/tasks/:id');
    expect(normalizeRoute('/api/v1/tasks/42/events')).toBe('/api/v1/tasks/:id/events');
  });

  it('collapses long hex / UUID segments', () => {
    expect(normalizeRoute('/artifacts/deadbeefdeadbeef1234')).toBe('/artifacts/:id');
    expect(
      normalizeRoute('/runs/550e8400-e29b-41d4-a716-446655440000'),
    ).toBe('/runs/:id');
  });

  it('leaves short / alphabetic segments alone', () => {
    expect(normalizeRoute('/tasks')).toBe('/tasks');
    expect(normalizeRoute('/api/v1/tasks')).toBe('/api/v1/tasks');
  });
});

describe('createMetricsMiddleware', () => {
  it('increments counters on each request', async () => {
    const app = new Hono();
    app.use('*', createMetricsMiddleware());
    app.get('/hello', (c) => c.text('hi'));

    const before = (await import('../src/metrics.js')).httpRequestsTotal.get({
      method: 'GET',
      route: '/hello',
      status: 200,
      team: 'unknown',
    });

    await app.request('/hello');
    await app.request('/hello');

    const after = (await import('../src/metrics.js')).httpRequestsTotal.get({
      method: 'GET',
      route: '/hello',
      status: 200,
      team: 'unknown',
    });
    expect(after - before).toBe(2);
  });

  it('skips /metrics path', async () => {
    const app = new Hono();
    app.use('*', createMetricsMiddleware());
    app.get('/metrics', (c) => c.text('ok'));

    const before = (await import('../src/metrics.js')).httpRequestsTotal.get({
      method: 'GET',
      route: '/metrics',
      status: 200,
      team: 'unknown',
    });
    await app.request('/metrics');
    const after = (await import('../src/metrics.js')).httpRequestsTotal.get({
      method: 'GET',
      route: '/metrics',
      status: 200,
      team: 'unknown',
    });
    expect(after - before).toBe(0);
  });

  it('uses team from auth context when set', async () => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth' as never, { teamId: 'team-xyz', agentId: 'a', scope: 'write' } as never);
      await next();
    });
    app.use('*', createMetricsMiddleware());
    app.get('/x', (c) => c.text('ok'));

    const { httpRequestsTotal } = await import('../src/metrics.js');
    const before = httpRequestsTotal.get({
      method: 'GET',
      route: '/x',
      status: 200,
      team: 'team-xyz',
    });
    await app.request('/x');
    const after = httpRequestsTotal.get({
      method: 'GET',
      route: '/x',
      status: 200,
      team: 'team-xyz',
    });
    expect(after - before).toBe(1);
  });

  it('collapses numeric IDs in the route label', async () => {
    const app = new Hono();
    app.use('*', createMetricsMiddleware());
    app.get('/tasks/:id', (c) => c.text('ok'));

    const { httpRequestsTotal } = await import('../src/metrics.js');
    const before = httpRequestsTotal.get({
      method: 'GET',
      route: '/tasks/:id',
      status: 200,
      team: 'unknown',
    });
    await app.request('/tasks/999');
    const after = httpRequestsTotal.get({
      method: 'GET',
      route: '/tasks/:id',
      status: 200,
      team: 'unknown',
    });
    expect(after - before).toBe(1);
  });
});
