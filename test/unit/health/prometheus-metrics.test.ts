/**
 * `PrometheusMetrics`: the outbox gauges read the database on each scrape, but
 * a read that fails or hangs never takes the rest of the registry down — the
 * gauges keep their last value, the failure is logged, and the scrape answers
 * within the read's time limit.
 *
 * @packageDocumentation
 */
import { describe, expect, test } from 'bun:test';
import type { OutboxBacklog } from '../../../src/messaging/application/outbox-backlog.ts';
import { PrometheusMetrics, type MetricsSources } from '../../../src/health/infrastructure/prometheus-metrics.ts';

function sources(overrides: Partial<MetricsSources> = {}): MetricsSources {
  return {
    readBacklog: async () => ({ pending: 0, lagSeconds: 0, stuck: 0 }),
    readDlqDepth: async () => 0,
    ...overrides,
  };
}

function recordingLog() {
  const lines: string[] = [];
  return { lines, warn: (message: string) => void lines.push(message) };
}

function gauge(text: string, name: string): number | undefined {
  const line = text.split('\n').find((candidate) => candidate.startsWith(`${name} `));
  return line === undefined ? undefined : Number(line.split(' ')[1]);
}

describe('PrometheusMetrics', () => {
  test('a backlog read that fails → the scrape still answers, the gauges keep their last value, the failure is logged', async () => {
    const log = recordingLog();
    let read: () => Promise<OutboxBacklog> = async () => ({ pending: 3, lagSeconds: 7, stuck: 1 });
    const metrics = new PrometheusMetrics(sources({ readBacklog: () => read() }), { timeoutMs: 50, log });
    await metrics.registry.metrics();
    metrics.lockConflict('lock_timeout');

    read = async () => {
      throw new TypeError('select pending from outbox where amount = 123.45');
    };
    const text = await metrics.registry.metrics();

    expect(gauge(text, 'outbox_pending')).toBe(3);
    expect(gauge(text, 'outbox_lag_seconds')).toBe(7);
    expect(text).toContain('lock_conflicts_total{reason="lock_timeout"} 1');
    expect(log.lines.length).toBeGreaterThan(0);
    expect(log.lines.join(' ')).toContain('TypeError');
    expect(log.lines.join(' ')).not.toContain('123.45');
  });

  test('a scrape reads the backlog once: both gauges come from the same read, a failure is logged once', async () => {
    const log = recordingLog();
    let reads = 0;
    let read: () => Promise<OutboxBacklog> = async () => ({ pending: ++reads, lagSeconds: reads * 10, stuck: reads * 100 });
    const metrics = new PrometheusMetrics(sources({ readBacklog: () => read() }), { timeoutMs: 50, log });

    const text = await metrics.registry.metrics();

    expect(reads).toBe(1);
    expect(gauge(text, 'outbox_pending')).toBe(1);
    expect(gauge(text, 'outbox_lag_seconds')).toBe(10);
    expect(gauge(text, 'outbox_stuck_messages')).toBe(100);

    read = async () => {
      throw new Error('connection refused');
    };
    await metrics.registry.metrics();

    expect(log.lines).toHaveLength(1);
  });

  test('a backlog read that hangs →the scrape answers within the time limit', async () => {
    const log = recordingLog();
    const metrics = new PrometheusMetrics(sources({ readBacklog: () => new Promise<OutboxBacklog>(() => {}) }), {
      timeoutMs: 50,
      log,
    });

    const started = performance.now();
    const text = await metrics.registry.metrics();

    expect(performance.now() - started).toBeLessThan(1000);
    expect(text).toContain('lock_conflicts_total');
    expect(log.lines.length).toBeGreaterThan(0);
  });

  test('the consumer retries and the DLQ sends are counted by failure code', async () => {
    const metrics = new PrometheusMetrics(sources(), {
      timeoutMs: 50,
      log: recordingLog(),
    });

    metrics.consumerRetry('TRANSIENT_LOCK_TIMEOUT');
    metrics.consumerRetry('TRANSIENT_LOCK_TIMEOUT');
    metrics.deadLettered('INVALID_PAYLOAD');
    const text = await metrics.registry.metrics();

    expect(text).toContain('wager_transactions_consumer_retries_total{failure_code="TRANSIENT_LOCK_TIMEOUT"} 2');
    expect(text).toContain('wager_transactions_dlq_messages_total{failure_code="INVALID_PAYLOAD"} 1');
  });

  test('the DLQ depth is read on each scrape; a read that fails keeps the last value and is logged', async () => {
    const log = recordingLog();
    let read: () => Promise<number> = async () => 4;
    const metrics = new PrometheusMetrics(sources({ readDlqDepth: () => read() }), { timeoutMs: 50, log });

    expect(gauge(await metrics.registry.metrics(), 'wager_transactions_dlq_depth')).toBe(4);

    read = () => new Promise<number>(() => {});
    const text = await metrics.registry.metrics();

    expect(gauge(text, 'wager_transactions_dlq_depth')).toBe(4);
    expect(log.lines).toHaveLength(1);
  });

  test('the series of the known labels exist from the start, at zero', async () => {
    const metrics = new PrometheusMetrics(sources(), { timeoutMs: 50, log: recordingLog() });

    const text = await metrics.registry.metrics();

    for (const series of [
      'wager_transactions_total{kind="BET",status="PROCESSED",channel="HTTP"} 0',
      'wager_transactions_total{kind="ROLLBACK",status="PENDING_REFERENCE",channel="QUEUE"} 0',
      'wager_transaction_idempotent_replays_total{channel="QUEUE"} 0',
      'wager_transaction_idempotency_conflicts_total{channel="HTTP"} 0',
      'rejected_submissions_total{failure_code="INVALID_PAYLOAD",channel="QUEUE"} 0',
      'lock_conflicts_total{reason="deadlock"} 0',
      'wager_transactions_consumer_retries_total{failure_code="TRANSIENT_UNAVAILABLE"} 0',
      'wager_transactions_dlq_messages_total{failure_code="INFRA_UNEXPECTED"} 0',
    ]) {
      expect(text).toContain(series);
    }
    expect(text).not.toContain('kind="OPENING"');
  });
});
