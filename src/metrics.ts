/**
 * Zero-dep Prometheus metrics exporter.
 *
 * Produces text/plain; version=0.0.4 exposition format. Supports three
 * primitive metric types with label dimensions: Counter, Histogram, Gauge.
 *
 * Designed for a single-process server — not distributed / multi-proc safe.
 * Good enough for Lattice's single-instance footprint.
 */

export type LabelValues = Record<string, string | number>;

/** Escape a label value per Prometheus text format rules. */
function escapeLabelValue(v: string): string {
  return v
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/"/g, '\\"');
}

/** Serialize label values into a canonical, sorted `{k="v",...}` string. */
function formatLabels(labelNames: readonly string[], values: LabelValues): string {
  if (labelNames.length === 0) return '';
  const parts: string[] = [];
  for (const name of labelNames) {
    const raw = values[name];
    const str = raw === undefined || raw === null ? '' : String(raw);
    parts.push(`${name}="${escapeLabelValue(str)}"`);
  }
  return '{' + parts.join(',') + '}';
}

/** Build a stable key from label values for Map lookup. */
function labelKey(labelNames: readonly string[], values: LabelValues): string {
  if (labelNames.length === 0) return '';
  const parts: string[] = [];
  for (const name of labelNames) {
    const raw = values[name];
    const str = raw === undefined || raw === null ? '' : String(raw);
    parts.push(str);
  }
  return parts.join('\x1f');
}

interface MetricBase {
  readonly name: string;
  readonly help: string;
  readonly type: 'counter' | 'gauge' | 'histogram';
  readonly labelNames: readonly string[];
  render(): string;
}

export interface MetricOptions {
  name: string;
  help: string;
  labelNames?: readonly string[];
}

export class Counter implements MetricBase {
  readonly name: string;
  readonly help: string;
  readonly type = 'counter' as const;
  readonly labelNames: readonly string[];
  private values = new Map<string, { labels: LabelValues; value: number }>();

  constructor(opts: MetricOptions) {
    this.name = opts.name;
    this.help = opts.help;
    this.labelNames = opts.labelNames ?? [];
  }

  inc(labels: LabelValues = {}, delta = 1): void {
    const key = labelKey(this.labelNames, labels);
    const existing = this.values.get(key);
    if (existing) {
      existing.value += delta;
    } else {
      this.values.set(key, { labels: { ...labels }, value: delta });
    }
  }

  get(labels: LabelValues = {}): number {
    const key = labelKey(this.labelNames, labels);
    return this.values.get(key)?.value ?? 0;
  }

  reset(): void {
    this.values.clear();
  }

  render(): string {
    const lines: string[] = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} counter`,
    ];
    if (this.values.size === 0) {
      // Emit a zero sample so scrapers see the metric exists.
      lines.push(`${this.name}${formatLabels(this.labelNames, {})} 0`);
    } else {
      for (const { labels, value } of this.values.values()) {
        lines.push(`${this.name}${formatLabels(this.labelNames, labels)} ${value}`);
      }
    }
    return lines.join('\n');
  }
}

export class Gauge implements MetricBase {
  readonly name: string;
  readonly help: string;
  readonly type = 'gauge' as const;
  readonly labelNames: readonly string[];
  private values = new Map<string, { labels: LabelValues; value: number }>();

  constructor(opts: MetricOptions) {
    this.name = opts.name;
    this.help = opts.help;
    this.labelNames = opts.labelNames ?? [];
  }

  set(labels: LabelValues, value: number): void;
  set(value: number): void;
  set(a: LabelValues | number, b?: number): void {
    if (typeof a === 'number') {
      const key = labelKey(this.labelNames, {});
      this.values.set(key, { labels: {}, value: a });
    } else {
      const key = labelKey(this.labelNames, a);
      this.values.set(key, { labels: { ...a }, value: b ?? 0 });
    }
  }

  inc(labels: LabelValues = {}, delta = 1): void {
    const key = labelKey(this.labelNames, labels);
    const existing = this.values.get(key);
    if (existing) existing.value += delta;
    else this.values.set(key, { labels: { ...labels }, value: delta });
  }

  get(labels: LabelValues = {}): number {
    const key = labelKey(this.labelNames, labels);
    return this.values.get(key)?.value ?? 0;
  }

  reset(): void {
    this.values.clear();
  }

  render(): string {
    const lines: string[] = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} gauge`,
    ];
    if (this.values.size === 0) {
      lines.push(`${this.name}${formatLabels(this.labelNames, {})} 0`);
    } else {
      for (const { labels, value } of this.values.values()) {
        lines.push(`${this.name}${formatLabels(this.labelNames, labels)} ${value}`);
      }
    }
    return lines.join('\n');
  }
}

interface HistogramBucket {
  labels: LabelValues;
  counts: number[]; // per-bucket cumulative counts (same length as buckets)
  sum: number;
  count: number;
}

export interface HistogramOptions extends MetricOptions {
  buckets: readonly number[];
}

export class Histogram implements MetricBase {
  readonly name: string;
  readonly help: string;
  readonly type = 'histogram' as const;
  readonly labelNames: readonly string[];
  readonly buckets: readonly number[];
  private series = new Map<string, HistogramBucket>();

  constructor(opts: HistogramOptions) {
    this.name = opts.name;
    this.help = opts.help;
    this.labelNames = opts.labelNames ?? [];
    // Ensure buckets are sorted ascending; do NOT include +Inf here — it's
    // emitted implicitly during render.
    this.buckets = [...opts.buckets].sort((a, b) => a - b);
  }

  observe(labels: LabelValues, value: number): void;
  observe(value: number): void;
  observe(a: LabelValues | number, b?: number): void {
    const labels = typeof a === 'number' ? {} : a;
    const value = typeof a === 'number' ? a : (b as number);
    const key = labelKey(this.labelNames, labels);
    let entry = this.series.get(key);
    if (!entry) {
      entry = {
        labels: { ...labels },
        counts: new Array(this.buckets.length).fill(0),
        sum: 0,
        count: 0,
      };
      this.series.set(key, entry);
    }
    entry.sum += value;
    entry.count += 1;
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]) entry.counts[i] += 1;
    }
  }

  getBucketCounts(labels: LabelValues = {}): number[] | undefined {
    const key = labelKey(this.labelNames, labels);
    return this.series.get(key)?.counts.slice();
  }

  getCount(labels: LabelValues = {}): number {
    const key = labelKey(this.labelNames, labels);
    return this.series.get(key)?.count ?? 0;
  }

  getSum(labels: LabelValues = {}): number {
    const key = labelKey(this.labelNames, labels);
    return this.series.get(key)?.sum ?? 0;
  }

  reset(): void {
    this.series.clear();
  }

  render(): string {
    const lines: string[] = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} histogram`,
    ];
    for (const entry of this.series.values()) {
      for (let i = 0; i < this.buckets.length; i++) {
        const le = this.buckets[i];
        const bucketLabels = { ...entry.labels, le: String(le) };
        const bucketLabelNames = [...this.labelNames, 'le'];
        lines.push(
          `${this.name}_bucket${formatLabels(bucketLabelNames, bucketLabels)} ${entry.counts[i]}`,
        );
      }
      const infLabels = { ...entry.labels, le: '+Inf' };
      const infNames = [...this.labelNames, 'le'];
      lines.push(
        `${this.name}_bucket${formatLabels(infNames, infLabels)} ${entry.count}`,
      );
      lines.push(`${this.name}_sum${formatLabels(this.labelNames, entry.labels)} ${entry.sum}`);
      lines.push(`${this.name}_count${formatLabels(this.labelNames, entry.labels)} ${entry.count}`);
    }
    return lines.join('\n');
  }
}

export class Registry {
  private metrics = new Map<string, MetricBase>();

  register<T extends MetricBase>(metric: T): T {
    if (this.metrics.has(metric.name)) {
      throw new Error(`Metric already registered: ${metric.name}`);
    }
    this.metrics.set(metric.name, metric);
    return metric;
  }

  unregister(name: string): void {
    this.metrics.delete(name);
  }

  get(name: string): MetricBase | undefined {
    return this.metrics.get(name);
  }

  render(): string {
    const blocks: string[] = [];
    for (const metric of this.metrics.values()) {
      blocks.push(metric.render());
    }
    return blocks.join('\n') + '\n';
  }

  resetAll(): void {
    for (const m of this.metrics.values()) {
      // Each primitive exposes reset()
      (m as unknown as { reset: () => void }).reset();
    }
  }
}

// ---- Singleton registry with Lattice's standard metrics ----

export const metricsRegistry = new Registry();

export const httpRequestsTotal = metricsRegistry.register(
  new Counter({
    name: 'lattice_http_requests_total',
    help: 'Total number of HTTP requests processed.',
    labelNames: ['method', 'route', 'status', 'workspace'],
  }),
);

export const httpRequestDurationMs = metricsRegistry.register(
  new Histogram({
    name: 'lattice_http_request_duration_ms',
    help: 'HTTP request duration in milliseconds.',
    labelNames: ['method', 'route'],
    buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
  }),
);

export const activeAgentsGauge = metricsRegistry.register(
  new Gauge({
    name: 'lattice_active_agents',
    help: 'Number of agents currently online per team.',
    labelNames: ['workspace'],
  }),
);

export const tasksGauge = metricsRegistry.register(
  new Gauge({
    name: 'lattice_tasks',
    help: 'Number of tasks by team and status.',
    labelNames: ['workspace', 'status'],
  }),
);

const eventsTotal = metricsRegistry.register(
  new Counter({
    name: 'lattice_events_total',
    help: 'Total number of events emitted.',
    labelNames: ['workspace', 'event_type'],
  }),
);

const upGauge = metricsRegistry.register(
  new Gauge({
    name: 'lattice_up',
    help: 'Lattice process liveness (1 = up).',
    labelNames: [],
  }),
);
upGauge.set(1);

export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';
