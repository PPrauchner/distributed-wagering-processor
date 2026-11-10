/**
 * Unit tests for `OutboxPublisherWorker`: it stops and waits for the cycle in
 * flight before the application shutdown hooks run — the ones that close the
 * ORM — so that cycle never ends against a closed pool.
 *
 * @packageDocumentation
 */
import { describe, expect, test } from 'bun:test';
import type { PublishOutbox } from '../../../src/messaging/application/publish-outbox.ts';
import { OutboxPublisherWorker } from '../../../src/messaging/interface/outbox-publisher.worker.ts';

describe('before the application shuts down', () => {
  test('the worker waits for the cycle in flight', async () => {
    let finishCycle: (() => void) | undefined;
    let cycleStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => (cycleStarted = resolve));
    const publishOutbox = {
      publishDue: () =>
        new Promise<number>((resolve) => {
          finishCycle = () => resolve(0);
          cycleStarted?.();
        }),
    } as unknown as PublishOutbox;
    const worker = new OutboxPublisherWorker(publishOutbox, { enabled: true, pollIntervalMs: 10_000 });
    worker.onApplicationBootstrap();
    await started;

    let stopped = false;
    const stopping = worker.beforeApplicationShutdown().then(() => (stopped = true));
    await Bun.sleep(10);
    expect(stopped).toBe(false);

    finishCycle?.();
    await stopping;
    expect(stopped).toBe(true);
  });
});
