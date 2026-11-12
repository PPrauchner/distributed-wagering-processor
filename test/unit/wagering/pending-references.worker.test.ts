/**
 * Unit tests for `PendingReferencesWorker`: the loop of the worker of pending
 * references on one instance. On shutdown it stops claiming, tells the cycle
 * in flight to leave the items it has not started, and waits for the one in
 * progress — before the shutdown hooks that close the ORM.
 *
 * @packageDocumentation
 */
import { describe, expect, test } from 'bun:test';
import type { ResolvePendingReferences } from '../../../src/wagering/application/resolve-pending-references.ts';
import { PendingReferencesWorker } from '../../../src/wagering/interface/pending-references.worker.ts';
import { captureNestLogs } from '../../support/nest-log-capture.ts';

describe('a failed cycle', () => {
  test('is logged by the error name, never its message', async () => {
    let failed: (() => void) | undefined;
    const cycleFailed = new Promise<void>((resolve) => (failed = resolve));
    const resolver = {
      resolveDue: async () => {
        failed?.();
        throw new TypeError('select balance 123.45');
      },
    } as unknown as ResolvePendingReferences;
    const worker = new PendingReferencesWorker(resolver, { enabled: true, pollIntervalMs: 10_000 });

    const lines = await captureNestLogs(async () => {
      worker.onApplicationBootstrap();
      await cycleFailed;
      await worker.beforeApplicationShutdown();
    });

    expect(lines.join(' ')).toContain('TypeError');
    expect(lines.join(' ')).not.toContain('123.45');
  });
});

/** A resolver whose cycle stays in flight until the test finishes it. */
function cycleInFlight(): {
  resolver: ResolvePendingReferences;
  started: Promise<void>;
  finish: () => void;
  stoppingSeen: () => boolean | undefined;
} {
  let finish = (): void => {};
  let markStarted = (): void => {};
  let isStopping: (() => boolean) | undefined;
  const started = new Promise<void>((resolve) => (markStarted = resolve));
  const resolver = {
    resolveDue: (stopping: () => boolean) =>
      new Promise<number>((resolve) => {
        isStopping = stopping;
        finish = () => resolve(0);
        markStarted();
      }),
  } as unknown as ResolvePendingReferences;
  return { resolver, started, finish: () => finish(), stoppingSeen: () => isStopping?.() };
}

describe('the pending references worker', () => {
  test('polls when enabled', async () => {
    const { resolver, started, finish } = cycleInFlight();
    const worker = new PendingReferencesWorker(resolver, { enabled: true, pollIntervalMs: 10_000 });

    worker.onApplicationBootstrap();

    await started;
    finish();
    await worker.beforeApplicationShutdown();
  });

  test('never polls when disabled', async () => {
    let cycles = 0;
    const resolver = { resolveDue: async () => (cycles += 1) } as unknown as ResolvePendingReferences;
    const worker = new PendingReferencesWorker(resolver, { enabled: false, pollIntervalMs: 1 });

    worker.onApplicationBootstrap();
    await worker.beforeApplicationShutdown();

    expect(cycles).toBe(0);
  });

  test('on shutdown: the cycle in flight is told to stop, and waited for', async () => {
    const { resolver, started, finish, stoppingSeen } = cycleInFlight();
    const worker = new PendingReferencesWorker(resolver, { enabled: true, pollIntervalMs: 10_000 });
    worker.onApplicationBootstrap();
    await started;
    expect(stoppingSeen()).toBe(false);

    let stopped = false;
    const stopping = worker.beforeApplicationShutdown().then(() => (stopped = true));
    await Promise.resolve();
    expect(stoppingSeen()).toBe(true);
    expect(stopped).toBe(false);

    finish();
    await stopping;
    expect(stopped).toBe(true);
  });
});

describe('a cycle that never ends', () => {
  test('holds the shutdown no longer than the drain timeout, and is logged', async () => {
    let cycleStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => (cycleStarted = resolve));
    const resolver = {
      resolveDue: () => {
        cycleStarted?.();
        return new Promise<number>(() => {});
      },
    } as unknown as ResolvePendingReferences;
    const worker = new PendingReferencesWorker(resolver, {
      enabled: true,
      pollIntervalMs: 10_000,
      drainTimeoutMs: 20,
    });

    const lines = await captureNestLogs(async () => {
      worker.onApplicationBootstrap();
      await started;
      await worker.beforeApplicationShutdown();
    });

    expect(lines.join(' ')).toContain('still in flight after 20 ms');
  });
});
