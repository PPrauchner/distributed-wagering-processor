/**
 * `CheckReadiness`: ready only when every probe passes, and a probe that does
 * not answer in time counts as down, with its signal aborted. A probe that
 * fails is logged and its reason — the error's name, never its stack — is in
 * the report.
 *
 * @packageDocumentation
 */
import { describe, expect, test } from 'bun:test';
import { CheckReadiness, type ReadinessProbe } from '../../../src/health/application/check-readiness.ts';
import type { LogDetails } from '../../../src/shared/application/context-log.ts';

function probe(name: string, check: (signal: AbortSignal) => Promise<void>): ReadinessProbe {
  return { name, check };
}

class QueueDoesNotExist extends Error {
  override readonly name = 'QueueDoesNotExist';
}

const up = (name: string) => probe(name, async () => {});
const down = (name: string) =>
  probe(name, async () => {
    throw new QueueDoesNotExist('refused at /some/stack/path');
  });

function recordingLog() {
  const lines: { message: string; details?: LogDetails }[] = [];
  return { lines, warn: (message: string, details?: LogDetails) => void lines.push({ message, details }) };
}

describe('CheckReadiness', () => {
  test('every probe up → ready, nothing logged', async () => {
    const log = recordingLog();
    const report = await new CheckReadiness([up('database'), up('queue')], 50, log).execute();

    expect(report).toEqual({ ready: true, checks: { database: 'up', queue: 'up' }, reasons: {} });
    expect(log.lines).toEqual([]);
  });

  test('one probe failing → not ready, the report names it and says why, the failure is logged', async () => {
    const log = recordingLog();
    const report = await new CheckReadiness([up('database'), down('queue')], 50, log).execute();

    expect(report).toEqual({
      ready: false,
      checks: { database: 'up', queue: 'down' },
      reasons: { queue: 'QueueDoesNotExist' },
    });
    expect(log.lines).toEqual([
      { message: 'readiness probe failed', details: { probe: 'queue', error: 'QueueDoesNotExist' } },
    ]);
  });

  test('a probe that hangs past the timeout → down by timeout, its signal aborted', async () => {
    let aborted = false;
    const hanging = probe('database', (signal) => {
      signal.addEventListener('abort', () => (aborted = true));
      return new Promise(() => {});
    });

    const started = performance.now();
    const report = await new CheckReadiness([hanging], 50, recordingLog()).execute();

    expect(report.checks).toEqual({ database: 'down' });
    expect(report.reasons).toEqual({ database: 'TimeoutError' });
    expect(aborted).toBe(true);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
