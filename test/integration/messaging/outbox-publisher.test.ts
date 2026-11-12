/**
 * The outbox publisher end to end, against the real PostgreSQL and the real
 * LocalStack: events committed while no publisher runs are delivered once one
 * starts; a publisher that dies between the send and `published_at`
 * (`crash-after-send`) is replaced, after the lease, by another that resends
 * the same `eventId` and the same body — recorded from the real SQS client —;
 * two concurrent publishers lose nothing; a failed send is
 * rescheduled — counted in `outbox_publish_retries_total` — and delivered once
 * SQS answers; the 10th failed attempt raises an alert with the message's id,
 * and the message counts in `outbox_stuck_messages`. Every test reads the events from
 * a `wagering-events` FIFO queue of its own, with a random suffix, and waits by
 * condition, never by a fixed sleep.
 *
 * The test database is shared with the other test files, whose outcomes leave
 * pending messages too: a publisher here may deliver them as well, so the
 * checks are about this file's events, and "unknown" means not in the outbox.
 *
 * @packageDocumentation
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { SQL } from 'bun';
import {
  CreateQueueCommand,
  DeleteMessageBatchCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  SendMessageBatchCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { createApp } from '../../../src/app.ts';
import { loadConfig, type AppConfig } from '../../../src/config.ts';
import { PrometheusMetrics } from '../../../src/health/infrastructure/prometheus-metrics.ts';
import { PublishOutbox } from '../../../src/messaging/application/publish-outbox.ts';
import { SqsEventPublisher } from '../../../src/messaging/infrastructure/sqs-event-publisher.ts';
import { FaultPoint, SimulatedCrashError, type FaultInjection } from '../../../src/shared/application/fault-injector.ts';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../src/shared/application/unit-of-work.ts';
import type { OutboxRepositories } from '../../../src/messaging/application/outbox-repository.ts';
import { expectLedgerConsistent } from '../ledger-invariant.ts';
import { waitUntil } from '../../support/wait-until.ts';

type JsonObject = Record<string, unknown>;

interface ReceivedEvent {
  envelope: JsonObject;
  groupId: string | undefined;
  deduplicationId: string | undefined;
}

const apps: INestApplication[] = [];
/** The publishers a test started; stopped after it, so none outlives its queue. */
const publishers: INestApplication[] = [];
const queues: string[] = [];
let config: AppConfig;
let baseUrl: string;
let sql: SQL;
let sqs: SQSClient;
/** The recording clients a test made; destroyed at the end. */
const recordingClients: SQSClient[] = [];
const touchedWallets: string[] = [];

beforeAll(async () => {
  config = loadConfig();
  // The submissions go through an instance without a publisher.
  baseUrl = await startApp(withPublisher(config, { enabled: false, queue: 'unused.fifo' }));
  sql = new SQL(config.databaseUrl);
  sqs = new SQSClient({
    endpoint: config.sqs.endpoint,
    region: config.sqs.region,
    credentials: { accessKeyId: config.sqs.accessKeyId, secretAccessKey: config.sqs.secretAccessKey },
  });
});

afterEach(async () => {
  await Promise.all(publishers.splice(0).map((app) => app.close()));
});

afterAll(async () => {
  await expectLedgerConsistent(sql, touchedWallets);
  await Promise.all(apps.map((app) => app.close()));
  await Promise.all(queues.map((QueueUrl) => sqs.send(new DeleteQueueCommand({ QueueUrl })).catch(() => undefined)));
  sqs?.destroy();
  for (const client of recordingClients) client.destroy();
  await sql?.close();
});

function withPublisher(
  base: AppConfig,
  options: { enabled: boolean; queue: string; leaseMs?: number; retryBaseMs?: number; faults?: FaultPoint[] },
): AppConfig {
  return {
    ...base,
    faultPoints: options.faults ?? [],
    sqs: { ...base.sqs, wageringEventsQueue: options.queue },
    outboxPublisher: {
      ...base.outboxPublisher,
      enabled: options.enabled,
      pollIntervalMs: 50,
      leaseMs: options.leaseMs ?? base.outboxPublisher.leaseMs,
      retryBaseMs: options.retryBaseMs ?? base.outboxPublisher.retryBaseMs,
      retryMaxMs: 5000,
    },
  };
}

async function startApp(appConfig: AppConfig): Promise<string> {
  const app = await createApp(appConfig);
  await app.listen(0, '127.0.0.1');
  apps.push(app);
  return app.getUrl();
}

async function startPublisher(appConfig: AppConfig, logLines: string[] = []): Promise<PublishOutbox> {
  const app = await createApp(appConfig, {
    logDestination: { write: (line: string) => void logLines.push(line) },
    logLevel: 'info',
  });
  await app.init();
  publishers.push(app);
  return app.get(PublishOutbox);
}

/** The value of an unlabelled sample of the started publisher's metrics. */
async function metricOf(name: string): Promise<number> {
  const text = await publishers.at(-1)!.get(PrometheusMetrics).registry.metrics();
  const line = text.split('\n').find((candidate) => candidate.startsWith(`${name} `));
  return line === undefined ? Number.NaN : Number(line.split(' ')[1]);
}

function randomQueueName(): string {
  return `wagering-events-${Bun.randomUUIDv7().slice(-12)}.fifo`;
}

async function createQueue(name: string): Promise<string> {
  const { QueueUrl } = await sqs.send(
    new CreateQueueCommand({ QueueName: name, Attributes: { FifoQueue: 'true' } }),
  );
  queues.push(QueueUrl!);
  return QueueUrl!;
}


/** Receives — and deletes — from the queue until every wanted event id arrived. */
async function receiveUntil(queueUrl: string, wanted: readonly string[]): Promise<Map<string, ReceivedEvent>> {
  const received = new Map<string, ReceivedEvent>();
  await waitUntil(async () => {
    const { Messages = [] } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        MessageSystemAttributeNames: ['MessageGroupId', 'MessageDeduplicationId'],
      }),
    );
    for (const message of Messages) {
      const envelope = JSON.parse(message.Body!) as JsonObject;
      received.set(envelope.eventId as string, {
        envelope,
        groupId: message.Attributes?.MessageGroupId,
        deduplicationId: message.Attributes?.MessageDeduplicationId,
      });
    }
    if (Messages.length > 0) {
      await sqs.send(
        new DeleteMessageBatchCommand({
          QueueUrl: queueUrl,
          Entries: Messages.map((message, index) => ({ Id: `${index}`, ReceiptHandle: message.ReceiptHandle! })),
        }),
      );
    }
    return wanted.every((id) => received.has(id)) ? true : undefined;
  }, 30_000);
  return received;
}

async function createWallet(amount: string): Promise<{ id: string; playerId: string }> {
  const playerId = Bun.randomUUIDv7();
  const response = await fetch(`${baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-correlation-id': `corr-open-${playerId}` },
    body: JSON.stringify({ playerId, initialBalance: { amount, currency: 'BRL' } }),
  });
  expect(response.status).toBe(201);
  const { id } = (await response.json()) as { id: string };
  touchedWallets.push(id);
  return { id, playerId };
}

async function bet(wallet: { id: string; playerId: string }, correlationId: string): Promise<string> {
  const externalTransactionId = Bun.randomUUIDv7();
  const response = await fetch(`${baseUrl}/wagering/transactions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `key-${externalTransactionId}`,
      'x-correlation-id': correlationId,
    },
    body: JSON.stringify({
      providerId: 'provider-a',
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { transactionId: string }).transactionId;
}

interface OutboxState {
  id: string;
  attempts: number;
  next_attempt_in_future: boolean;
  published: boolean;
}

async function outboxOf(walletId: string): Promise<OutboxState[]> {
  return sql`
    select id, attempts, coalesce(next_attempt_at > now(), false) as next_attempt_in_future,
           published_at is not null as published
      from outbox_messages where wallet_id = ${walletId}
  `;
}

async function allPublished(walletId: string): Promise<true | undefined> {
  return (await outboxOf(walletId)).every((row) => row.published) ? true : undefined;
}

describe('delivery after the commit', () => {
  test('with no publisher the events stay pending; a publisher started later delivers them, correlated', async () => {
    const wallet = await createWallet('100.00');
    const transactionId = await bet(wallet, 'corr-submission');
    const pending = await outboxOf(wallet.id);
    expect(pending).toHaveLength(4);
    expect(pending.every((row) => !row.published)).toBe(true);

    const queueName = randomQueueName();
    const queueUrl = await createQueue(queueName);
    await startPublisher(withPublisher(config, { enabled: true, queue: queueName }));

    const received = await receiveUntil(queueUrl, pending.map((row) => row.id));
    await waitUntil(() => allPublished(wallet.id));
    for (const row of pending) {
      const event = received.get(row.id)!;
      expect(event.groupId).toBe(wallet.id);
      expect(event.deduplicationId).toBe(row.id);
    }
    const ofTheBet = [...received.values()].filter((event) => event.envelope.causationId === transactionId);
    expect(ofTheBet.map((event) => event.envelope.eventType).sort()).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    for (const event of ofTheBet) expect(event.envelope.correlationId).toBe('corr-submission');
  }, 40_000);
});

describe('a publisher that dies between the send and published_at', () => {
  test('after the lease, another instance resends the same eventId, with the same deduplication id', async () => {
    const wallet = await createWallet('100.00');
    const ids = (await outboxOf(wallet.id)).map((row) => row.id);
    const queueName = randomQueueName();
    const queueUrl = await createQueue(queueName);
    const leaseMs = 500;
    const dying = await startPublisher(
      withPublisher(config, { enabled: false, queue: queueName, leaseMs, faults: [FaultPoint.CrashAfterSend] }),
    );

    // It sends, then "dies" before recording the publication.
    const sent = new Map<string, ReceivedEvent>();
    await waitUntil(async () => {
      await dying.publishDue().catch((error: unknown) => {
        if (!(error instanceof SimulatedCrashError)) throw error;
      });
      for (const [id, event] of await receiveSome(queueUrl)) sent.set(id, event);
      return ids.every((id) => sent.has(id)) ? true : undefined;
    }, 30_000);
    expect((await outboxOf(wallet.id)).every((row) => !row.published && row.attempts === 0)).toBe(true);
    for (const id of ids) expect(sent.get(id)!.deduplicationId).toBe(id);

    const survivor = await startPublisher(withPublisher(config, { enabled: false, queue: queueName, leaseMs }));
    await waitUntil(async () => {
      await survivor.publishDue();
      return allPublished(wallet.id);
    });

    expect((await outboxOf(wallet.id)).map((row) => row.id).sort()).toEqual([...ids].sort());
  }, 60_000);

  test('two publishers with an expired lease publish the same item: same eventId and the same body to the real SQS', async () => {
    const wallet = await createWallet('100.00');
    const ids = (await outboxOf(wallet.id)).map((row) => row.id);
    const queueName = randomQueueName();
    await createQueue(queueName);
    const leaseMs = 500;
    const sends: SentEntry[] = [];
    const first = await recordingPublisher(
      withPublisher(config, { enabled: false, queue: queueName, leaseMs, faults: [FaultPoint.CrashAfterSend] }),
      'first',
      sends,
    );
    const second = await recordingPublisher(withPublisher(config, { enabled: false, queue: queueName, leaseMs }), 'second', sends);
    const sentBy = (publisher: string, id: string) =>
      sends.filter((entry) => entry.publisher === publisher && entry.deduplicationId === id);

    // The first sends and dies before recording the publication: its lease expires.
    await waitUntil(async () => {
      await first.publishDue().catch((error: unknown) => {
        if (!(error instanceof SimulatedCrashError)) throw error;
      });
      return ids.every((id) => sentBy('first', id).length > 0) ? true : undefined;
    });
    // The second claims the expired items and sends them again.
    await waitUntil(async () => {
      await second.publishDue();
      return allPublished(wallet.id);
    });

    for (const id of ids) {
      const both = [...sentBy('first', id), ...sentBy('second', id)];
      expect(sentBy('second', id)).toHaveLength(1);
      expect(new Set(both.map((entry) => entry.body)).size, id).toBe(1);
      expect((JSON.parse(both[0]!.body) as JsonObject).eventId).toBe(id);
    }
  }, 60_000);

  /** One receive: what arrived, deleted from the queue. */
  async function receiveSome(queueUrl: string): Promise<Map<string, ReceivedEvent>> {
    const { Messages = [] } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 0,
        MessageSystemAttributeNames: ['MessageGroupId', 'MessageDeduplicationId'],
      }),
    );
    if (Messages.length > 0) {
      await sqs.send(
        new DeleteMessageBatchCommand({
          QueueUrl: queueUrl,
          Entries: Messages.map((message, index) => ({ Id: `${index}`, ReceiptHandle: message.ReceiptHandle! })),
        }),
      );
    }
    return new Map(
      Messages.map((message) => {
        const envelope = JSON.parse(message.Body!) as JsonObject;
        return [
          envelope.eventId as string,
          {
            envelope,
            groupId: message.Attributes?.MessageGroupId,
            deduplicationId: message.Attributes?.MessageDeduplicationId,
          },
        ];
      }),
    );
  }
});

/** One entry of a `SendMessageBatch` the real SQS accepted, as a publisher sent it. */
interface SentEntry {
  publisher: string;
  deduplicationId: string;
  body: string;
}

/**
 * A real SQS client that records — not mocks — every batch entry the queue
 * accepted: the call still goes to LocalStack.
 */
function recordingSqsClient(publisher: string, sends: SentEntry[]): SQSClient {
  const client = new SQSClient({
    endpoint: config.sqs.endpoint,
    region: config.sqs.region,
    credentials: { accessKeyId: config.sqs.accessKeyId, secretAccessKey: config.sqs.secretAccessKey },
  });
  recordingClients.push(client);
  const send = client.send.bind(client) as (command: unknown) => Promise<unknown>;
  client.send = (async (command: unknown) => {
    const response = await send(command);
    if (command instanceof SendMessageBatchCommand) {
      const accepted = new Set(
        ((response as { Successful?: { Id?: string }[] }).Successful ?? []).map((entry) => entry.Id),
      );
      for (const entry of command.input.Entries ?? []) {
        if (accepted.has(entry.Id)) {
          sends.push({ publisher, deduplicationId: entry.MessageDeduplicationId!, body: entry.MessageBody! });
        }
      }
    }
    return response;
  }) as typeof client.send;
  return client;
}

/**
 * A publisher over the outbox of an app started with `appConfig` — its unit
 * of work, its fault points —, sending through a recording SQS client.
 */
async function recordingPublisher(appConfig: AppConfig, name: string, sends: SentEntry[]): Promise<PublishOutbox> {
  const app = await createApp(appConfig);
  await app.init();
  publishers.push(app);
  const { leaseMs, retryBaseMs, retryMaxMs } = appConfig.outboxPublisher;
  return new PublishOutbox(
    app.get<UnitOfWork<OutboxRepositories & FaultInjection>>(UNIT_OF_WORK),
    new SqsEventPublisher(recordingSqsClient(name, sends), appConfig.sqs.wageringEventsQueue),
    { leaseMs, backoff: { baseMs: retryBaseMs, maxMs: retryMaxMs } },
    { warn: () => undefined },
    { publishRetry: () => undefined },
  );
}

describe('two concurrent publishers over the same outbox', () => {
  test('every eventId reaches the queue, none is unknown, and every row ends published', async () => {
    const wallets = await Promise.all(Array.from({ length: 3 }, () => createWallet('100.00')));
    for (const wallet of wallets) {
      for (let i = 0; i < 4; i += 1) await bet(wallet, `corr-${i}`);
    }
    const ids = (await Promise.all(wallets.map((wallet) => outboxOf(wallet.id)))).flat().map((row) => row.id);
    expect(ids).toHaveLength(30);
    const queueName = randomQueueName();
    const queueUrl = await createQueue(queueName);

    await Promise.all([
      startPublisher(withPublisher(config, { enabled: true, queue: queueName })),
      startPublisher(withPublisher(config, { enabled: true, queue: queueName })),
    ]);
    const received = await receiveUntil(queueUrl, ids);
    for (const wallet of wallets) await waitUntil(() => allPublished(wallet.id));

    const receivedIds = [...received.keys()];
    const known: { id: string }[] = await sql`select id from outbox_messages where id in ${sql(receivedIds)}`;
    expect(known).toHaveLength(receivedIds.length);
  }, 60_000);
});

describe('a failed send', () => {
  test('is rescheduled with one more attempt and a next attempt in the future, then published once SQS answers', async () => {
    const wallet = await createWallet('100.00');
    // The queue does not exist yet: every send fails.
    const queueName = randomQueueName();
    const publisher = await startPublisher(
      withPublisher(config, { enabled: false, queue: queueName, retryBaseMs: 5000 }),
    );

    const rescheduled = await waitUntil(async () => {
      await publisher.publishDue();
      const rows = await outboxOf(wallet.id);
      return rows.every((row) => row.attempts === 1) ? rows : undefined;
    });
    expect(rescheduled.every((row) => !row.published && row.next_attempt_in_future)).toBe(true);

    const queueUrl = await createQueue(queueName);
    await waitUntil(async () => {
      await publisher.publishDue();
      return allPublished(wallet.id);
    });

    await receiveUntil(queueUrl, rescheduled.map((row) => row.id));
  }, 60_000);

  test('is counted; the 10th failed attempt raises an alert with the id and no payload, and the message is stuck', async () => {
    const wallet = await createWallet('100.00');
    // One failure away from stuck, due now.
    await sql`update outbox_messages set attempts = 9, next_attempt_at = now() where wallet_id = ${wallet.id}`;
    const ids = (await outboxOf(wallet.id)).map((row) => row.id);
    const logLines: string[] = [];
    // The queue does not exist: every send fails.
    const publisher = await startPublisher(
      withPublisher(config, { enabled: false, queue: randomQueueName(), retryBaseMs: 5000 }),
      logLines,
    );
    const retriesBefore = await metricOf('outbox_publish_retries_total');

    await waitUntil(async () => {
      await publisher.publishDue();
      return (await outboxOf(wallet.id)).every((row) => row.attempts === 10) ? true : undefined;
    });

    expect((await metricOf('outbox_publish_retries_total')) - retriesBefore).toBeGreaterThanOrEqual(ids.length);
    const alerts = logLines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.level === 40 && ids.includes(entry.messageId as string));
    expect(alerts.map((entry) => entry.messageId).sort()).toEqual([...ids].sort());
    expect(alerts.every((entry) => entry.attempts === 10 && !('payload' in entry))).toBe(true);
    expect(await metricOf('outbox_stuck_messages')).toBeGreaterThanOrEqual(ids.length);
  }, 60_000);
});
