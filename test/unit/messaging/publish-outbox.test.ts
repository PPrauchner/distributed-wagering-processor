/**
 * Unit tests for `PublishOutbox`: a send that fails — the whole batch, or some
 * of its entries — is rescheduled and logged with its reason, never silently;
 * every reschedule is counted, and the 10th failed attempt of a message raises
 * an alert with its id, without its payload.
 *
 * @packageDocumentation
 */
import { describe, expect, test } from 'bun:test';
import type { EventPublisher, PublishResult } from '../../../src/messaging/application/event-publisher.ts';
import type { OutboxRepositories, OutboxRepository } from '../../../src/messaging/application/outbox-repository.ts';
import { PublishOutbox, type PublicationLog } from '../../../src/messaging/application/publish-outbox.ts';
import type { OutboxMetrics } from '../../../src/messaging/application/outbox-metrics.ts';
import { OutboxMessage } from '../../../src/messaging/domain/outbox-message.ts';
import type { LogDetails } from '../../../src/shared/application/context-log.ts';
import type { FaultInjection } from '../../../src/shared/application/fault-injector.ts';
import type { UnitOfWork } from '../../../src/shared/application/unit-of-work.ts';

const WALLET_ID = '0192f291-27dd-7d3f-8071-5f8685deef37';
const NOW = new Date('2026-11-10T12:00:00.000Z');

const message = (id: string, attempts = 0): OutboxMessage =>
  OutboxMessage.rehydrate({
    id,
    aggregateId: WALLET_ID,
    eventType: 'WalletBalanceChanged',
    walletId: WALLET_ID,
    payload: { secret: 'payload' },
    occurredAt: NOW,
    attempts,
  });

/** An outbox holding `messages`, all due; records what was marked and rescheduled. */
function outboxOf(messages: OutboxMessage[]): OutboxRepository & { published: string[]; rescheduled: string[] } {
  const published: string[] = [];
  const rescheduled: string[] = [];
  return {
    published,
    rescheduled,
    add: () => undefined,
    claimDue: async () => messages,
    markPublished: async (m) => void published.push(m.id),
    reschedule: async (m) => void rescheduled.push(m.id),
  };
}

function unitOfWorkOver(outbox: OutboxRepository): UnitOfWork<OutboxRepositories & FaultInjection> {
  return { run: (work) => work({ outbox, faults: { inject: async () => undefined } }) };
}

function logSpy(): PublicationLog & { warnings: string[]; details: (LogDetails | undefined)[] } {
  const warnings: string[] = [];
  const details: (LogDetails | undefined)[] = [];
  return {
    warnings,
    details,
    warn: (line, fields) => {
      warnings.push(line);
      details.push(fields);
    },
  };
}

function metricsSpy(): OutboxMetrics & { retries: number } {
  return {
    retries: 0,
    publishRetry() {
      this.retries++;
    },
  };
}

const failing: EventPublisher = {
  publish: async () => {
    throw new Error('AWS.SimpleQueueService.NonExistentQueue');
  },
};

function publishOutbox(
  outbox: OutboxRepository,
  publisher: EventPublisher,
  log: PublicationLog,
  metrics: OutboxMetrics = metricsSpy(),
): PublishOutbox {
  return new PublishOutbox(
    unitOfWorkOver(outbox),
    publisher,
    { leaseMs: 30_000, backoff: { baseMs: 1000, maxMs: 5000 } },
    log,
    metrics,
    () => NOW,
  );
}

describe('a batch that could not be sent at all', () => {
  test('reschedules every message and logs the error with the batch size', async () => {
    const outbox = outboxOf([message('m-1'), message('m-2')]);
    const log = logSpy();

    await publishOutbox(outbox, failing, log).publishDue();

    expect(outbox.rescheduled).toEqual(['m-1', 'm-2']);
    expect(log.warnings).toHaveLength(1);
    expect(log.warnings[0]).toContain('2');
    expect(log.warnings[0]).toContain('AWS.SimpleQueueService.NonExistentQueue');
  });
});

describe('a batch with some entries refused', () => {
  test('reschedules the refused ones and logs each with its reason', async () => {
    const outbox = outboxOf([message('m-1'), message('m-2')]);
    const log = logSpy();
    const partial: EventPublisher = {
      publish: async (): Promise<PublishResult> => ({
        published: ['m-1'],
        failed: [{ id: 'm-2', reason: 'InternalError: try again' }],
      }),
    };

    await publishOutbox(outbox, partial, log).publishDue();

    expect(outbox.published).toEqual(['m-1']);
    expect(outbox.rescheduled).toEqual(['m-2']);
    expect(log.warnings).toHaveLength(1);
    expect(log.warnings[0]).toContain('m-2');
    expect(log.warnings[0]).toContain('InternalError: try again');
  });
});

describe('a batch sent whole', () => {
  test('logs nothing', async () => {
    const outbox = outboxOf([message('m-1')]);
    const log = logSpy();
    const ok: EventPublisher = { publish: async () => ({ published: ['m-1'], failed: [] }) };

    await publishOutbox(outbox, ok, log).publishDue();

    expect(outbox.published).toEqual(['m-1']);
    expect(log.warnings).toEqual([]);
  });
});

describe('a reschedule', () => {
  test('is counted once per message rescheduled', async () => {
    const metrics = metricsSpy();

    await publishOutbox(outboxOf([message('m-1'), message('m-2')]), failing, logSpy(), metrics).publishDue();

    expect(metrics.retries).toBe(2);
  });

  test('the 10th failed attempt of a message raises an alert with its id and no payload; the 9th and 11th do not', async () => {
    const log = logSpy();
    const outbox = outboxOf([message('m-8', 8), message('m-9', 9), message('m-10', 10)]);

    await publishOutbox(outbox, failing, log).publishDue();

    const alerts = log.warnings.filter((line) => line.includes('attempts'));
    expect(alerts).toHaveLength(1);
    const fields = log.details[log.warnings.indexOf(alerts[0]!)];
    expect(fields).toEqual({ messageId: 'm-9', eventType: 'WalletBalanceChanged', attempts: 10 });
    expect(JSON.stringify(log.details)).not.toContain('payload');
  });
});
