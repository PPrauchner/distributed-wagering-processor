/**
 * `CheckReadiness`: ready only when every probe passes, and a probe that does
 * not answer in time counts as down, with its signal aborted.
 *
 * @packageDocumentation
 */
import { describe, expect, test } from 'bun:test';
import { CheckReadiness, type ReadinessProbe } from '../../../src/health/application/check-readiness.ts';

function probe(name: string, check: (signal: AbortSignal) => Promise<void>): ReadinessProbe {
  return { name, check };
}

const up = (name: string) => probe(name, async () => {});
const down = (name: string) =>
  probe(name, async () => {
    throw new Error('refused');
  });

describe('CheckReadiness', () => {
  test('every probe up → ready', async () => {
    const report = await new CheckReadiness([up('database'), up('queue')], 50).execute();

    expect(report).toEqual({ ready: true, checks: { database: 'up', queue: 'up' } });
  });

  test('one probe failing → not ready, and the report names it', async () => {
    const report = await new CheckReadiness([up('database'), down('queue')], 50).execute();

    expect(report).toEqual({ ready: false, checks: { database: 'up', queue: 'down' } });
  });

  test('a probe that hangs past the timeout → down, its signal aborted', async () => {
    let aborted = false;
    const hanging = probe('database', (signal) => {
      signal.addEventListener('abort', () => (aborted = true));
      return new Promise(() => {});
    });

    const started = performance.now();
    const report = await new CheckReadiness([hanging], 50).execute();

    expect(report.checks).toEqual({ database: 'down' });
    expect(aborted).toBe(true);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
