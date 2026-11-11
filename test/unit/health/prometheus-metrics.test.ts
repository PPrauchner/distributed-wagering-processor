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
import { PrometheusMetrics } from '../../../src/health/infrastructure/prometheus-metrics.ts';

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
    let read: () => Promise<OutboxBacklog> = async () => ({ pending: 3, lagSeconds: 7 });
    const metrics = new PrometheusMetrics(() => read(), { timeoutMs: 50, log });
    await metrics.registry.metrics();
    metrics.lockConflict('lock_timeout');

    read = async () => {
      throw new Error('connection refused');
    };
    const text = await metrics.registry.metrics();

    expect(gauge(text, 'outbox_pending')).toBe(3);
    expect(gauge(text, 'outbox_lag_seconds')).toBe(7);
    expect(text).toContain('lock_conflicts_total{reason="lock_timeout"} 1');
    expect(log.lines.length).toBeGreaterThan(0);
  });

  test('a backlog read that hangs → the scrape answers within the time limit', async () => {
    const log = recordingLog();
    const metrics = new PrometheusMetrics(() => new Promise<OutboxBacklog>(() => {}), { timeoutMs: 50, log });

    const started = performance.now();
    const text = await metrics.registry.metrics();

    expect(performance.now() - started).toBeLessThan(1000);
    expect(text).toContain('lock_conflicts_total');
    expect(log.lines.length).toBeGreaterThan(0);
  });
});
