/**
 * The consumer of `wager-transactions.fifo` end to end, against the real
 * PostgreSQL and the real LocalStack: a message settles through the same use
 * case as the HTTP endpoint, with its inbox row, its events and its `ack`
 * after the commit; a redelivery is acknowledged with no effect; the same
 * submission by HTTP and by the queue has one effect; a process that dies
 * between the commit and the `ack` (`crash-after-commit`) leaves a message
 * whose redelivery duplicates nothing. Every test uses input and event queues
 * of its own, with a random suffix, and waits by condition, never by a fixed
 * sleep. Ends checking the ledger invariant of every wallet it touched.
 *
 * @packageDocumentation
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { SQL } from 'bun';
import {
  CreateQueueCommand,
  DeleteMessageBatchCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { createApp } from '../../../src/app.ts';
import { loadConfig, type AppConfig } from '../../../src/config.ts';
import { FaultPoint } from '../../../src/shared/application/fault-injector.ts';
import { hashPayload } from '../../../src/shared/application/payload-hash.ts';
import { expectLedgerConsistent } from '../ledger-invariant.ts';
import { waitUntil } from '../../support/wait-until.ts';

type JsonObject = Record<string, unknown>;

interface TestWallet {
  id: string;
  playerId: string;
}

const CONSUMER = 'wager-transactions-consumer';

const apps: INestApplication[] = [];
const queues: string[] = [];
let config: AppConfig;
let sql: SQL;
let sqs: SQSClient;
const touchedWallets: string[] = [];

/** The main instance: HTTP, consumer of its own input queue, publisher to its own event queue. */
let baseUrl: string;
let inputQueueUrl: string;
let eventsQueueUrl: string;

beforeAll(async () => {
  config = loadConfig();
  sql = new SQL(config.databaseUrl);
  sqs = new SQSClient({
    endpoint: config.sqs.endpoint,
    region: config.sqs.region,
    credentials: { accessKeyId: config.sqs.accessKeyId, secretAccessKey: config.sqs.secretAccessKey },
  });
  const input = await createQueue('wager-transactions');
  const events = await createQueue('wagering-events');
  inputQueueUrl = input.url;
  eventsQueueUrl = events.url;
  const app = await startApp(instanceConfig({ inputQueue: input.name, eventsQueue: events.name, publisher: true }));
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
});

afterAll(async () => {
  await expectLedgerConsistent(sql, touchedWallets);
  await Promise.all(apps.map((app) => app.close()));
  await Promise.all(queues.map((QueueUrl) => sqs.send(new DeleteQueueCommand({ QueueUrl })).catch(() => undefined)));
  sqs?.destroy();
  await sql?.close();
});

function instanceConfig(options: {
  inputQueue: string;
  eventsQueue: string;
  publisher: boolean;
  visibilityTimeoutSeconds?: number;
  faults?: FaultPoint[];
}): AppConfig {
  return {
    ...config,
    faultPoints: options.faults ?? [],
    sqs: { ...config.sqs, wagerTransactionsQueue: options.inputQueue, wageringEventsQueue: options.eventsQueue },
    outboxPublisher: { ...config.outboxPublisher, enabled: options.publisher, pollIntervalMs: 50 },
    wagerTransactionsConsumer: {
      ...config.wagerTransactionsConsumer,
      enabled: true,
      waitTimeSeconds: 1,
      batchSize: 10,
      visibilityTimeoutSeconds: options.visibilityTimeoutSeconds ?? 30,
    },
  };
}

async function startApp(appConfig: AppConfig): Promise<INestApplication> {
  const app = await createApp(appConfig);
  apps.push(app);
  return app;
}

async function stop(app: INestApplication): Promise<void> {
  apps.splice(apps.indexOf(app), 1);
  await app.close();
}

async function createQueue(prefix: string): Promise<{ name: string; url: string }> {
  const name = `${prefix}-${Bun.randomUUIDv7().slice(-12)}.fifo`;
  const { QueueUrl } = await sqs.send(new CreateQueueCommand({ QueueName: name, Attributes: { FifoQueue: 'true' } }));
  queues.push(QueueUrl!);
  return { name, url: QueueUrl! };
}


async function createWallet(amount: string): Promise<TestWallet> {
  const playerId = Bun.randomUUIDv7();
  const response = await fetch(`${baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, initialBalance: { amount, currency: 'BRL' } }),
  });
  expect(response.status).toBe(201);
  const { id } = (await response.json()) as { id: string };
  touchedWallets.push(id);
  return { id, playerId };
}

/** The `data` of a `BET`, with its idempotency key. */
function betData(wallet: TestWallet, amount = '25.00'): JsonObject {
  const externalTransactionId = Bun.randomUUIDv7();
  return {
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount, currency: 'BRL' },
  };
}

/** Sends the §10 envelope; each send is a new SQS message, even with the same `messageId`. */
async function send(queueUrl: string, data: JsonObject, messageId: string = Bun.randomUUIDv7()): Promise<string> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({
        messageId,
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data,
      }),
      MessageGroupId: data.walletId as string,
      MessageDeduplicationId: Bun.randomUUIDv7(),
    }),
  );
  return messageId;
}

/** Submits the same business fields by HTTP, with the key of `data`. */
function submitByHttp(data: JsonObject): Promise<Response> {
  const { idempotencyKey, ...body } = data;
  return fetch(`${baseUrl}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey as string },
    body: JSON.stringify(body),
  });
}

/** Messages in the queue, visible or in flight: not acknowledged yet. */
async function messagesLeft(queueUrl: string): Promise<number> {
  const { Attributes = {} } = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return Number(Attributes.ApproximateNumberOfMessages) + Number(Attributes.ApproximateNumberOfMessagesNotVisible);
}

/** Resolves once every message of the queue was acknowledged. */
async function drained(queueUrl: string): Promise<true | undefined> {
  return (await messagesLeft(queueUrl)) === 0 ? true : undefined;
}

interface TransactionRow {
  id: string;
  status: string;
  failure_code: string | null;
  correlation_id: string;
}

async function transactionsOf(data: JsonObject): Promise<TransactionRow[]> {
  return sql`
    select id, status, failure_code, correlation_id from wager_transactions
     where provider_id = ${data.providerId as string} and external_transaction_id = ${data.externalTransactionId as string}
  `;
}

async function inboxRow(messageId: string): Promise<{ payload_hash: string; processed: boolean } | undefined> {
  const [row] = await sql`
    select payload_hash, processed_at is not null as processed
      from inbox_messages where consumer_name = ${CONSUMER} and message_id = ${messageId}
  `;
  return row;
}

interface WalletState {
  balance_amount: string;
  version: number;
  entries: number;
  outbox: number;
}

async function walletState(walletId: string): Promise<WalletState> {
  const [row] = await sql`
    select w.balance_amount::text, w.version,
           (select count(*)::int from wallet_ledger_entries where wallet_id = w.id) as entries,
           (select count(*)::int from outbox_messages where wallet_id = w.id) as outbox
      from wallets w where w.id = ${walletId}
  `;
  return row;
}

/** Receives — and deletes — events until every wanted transaction has its events. */
const receivedEvents: JsonObject[] = [];
async function eventsCausedBy(transactionId: string, count: number): Promise<JsonObject[]> {
  return waitUntil(async () => {
    const { Messages = [] } = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: eventsQueueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }),
    );
    for (const message of Messages) receivedEvents.push(JSON.parse(message.Body!) as JsonObject);
    if (Messages.length > 0) {
      await sqs.send(
        new DeleteMessageBatchCommand({
          QueueUrl: eventsQueueUrl,
          Entries: Messages.map((message, index) => ({ Id: `${index}`, ReceiptHandle: message.ReceiptHandle! })),
        }),
      );
    }
    const caused = receivedEvents.filter((event) => event.causationId === transactionId);
    return caused.length >= count ? caused : undefined;
  }, 30_000);
}

async function inboxDuplicates(url: string): Promise<number> {
  const text = await (await fetch(`${url}/metrics`)).text();
  const line = text.split('\n').find((row) => row.startsWith('inbox_duplicates_total '));
  return Number(line?.split(' ')[1]);
}

describe('a message with a valid BET', () => {
  test('ends PROCESSED, with its inbox row and the events of the same submission by HTTP, and is acknowledged', async () => {
    const wallet = await createWallet('100.00');
    const data = betData(wallet);

    const messageId = await send(inputQueueUrl, data);
    const [transaction] = await waitUntil(async () => {
      const rows = await transactionsOf(data);
      return rows.length > 0 ? rows : undefined;
    });
    await waitUntil(() => drained(inputQueueUrl));

    expect(transaction!.status).toBe('PROCESSED');
    expect(transaction!.correlation_id).toBe(messageId);
    expect(await inboxRow(messageId)).toEqual({ payload_hash: hashPayload(data as never), processed: true });
    expect(await walletState(wallet.id)).toMatchObject({ balance_amount: '75.00', version: 2, entries: 2 });

    const byQueue = await eventsCausedBy(transaction!.id, 2);
    const httpWallet = await createWallet('100.00');
    const byHttp = await submitByHttp(betData(httpWallet));
    const { transactionId } = (await byHttp.json()) as { transactionId: string };
    const httpEvents = await eventsCausedBy(transactionId, 2);
    const types = (events: JsonObject[]) => events.map((event) => event.eventType).sort();
    expect(types(byQueue)).toEqual(types(httpEvents));
    expect(types(byQueue)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    for (const event of byQueue) expect(event.correlationId).toBe(messageId);
  }, 60_000);
});

describe('a message with a BET beyond the balance', () => {
  test('ends REJECTED INSUFFICIENT_FUNDS, with its inbox row and rejection event, and is acknowledged', async () => {
    const wallet = await createWallet('10.00');
    const data = betData(wallet, '25.00');

    const messageId = await send(inputQueueUrl, data);
    const [transaction] = await waitUntil(async () => {
      const rows = await transactionsOf(data);
      return rows.length > 0 ? rows : undefined;
    });
    await waitUntil(() => drained(inputQueueUrl));

    expect(transaction).toMatchObject({ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' });
    expect(await inboxRow(messageId)).toBeDefined();
    const events = await eventsCausedBy(transaction!.id, 1);
    expect(events.map((event) => event.eventType)).toEqual(['WagerTransactionRejected']);
  }, 60_000);
});

describe('a redelivery of the same messageId', () => {
  test('is acknowledged with no effect, and counted as an inbox duplicate', async () => {
    const wallet = await createWallet('100.00');
    const data = betData(wallet);
    const messageId = await send(inputQueueUrl, data);
    await waitUntil(async () => ((await inboxRow(messageId)) ? true : undefined));
    await waitUntil(() => drained(inputQueueUrl));
    const before = await walletState(wallet.id);
    const duplicatesBefore = await inboxDuplicates(baseUrl);

    await send(inputQueueUrl, data, messageId);
    await waitUntil(async () => ((await inboxDuplicates(baseUrl)) > duplicatesBefore ? true : undefined));
    await waitUntil(() => drained(inputQueueUrl));

    expect(await walletState(wallet.id)).toEqual(before);
    expect(await transactionsOf(data)).toHaveLength(1);
  }, 60_000);
});

describe('the same submission by HTTP and by the queue', () => {
  test('HTTP first: the message is a replay, acknowledged with no effect', async () => {
    const wallet = await createWallet('100.00');
    const data = betData(wallet);
    expect((await submitByHttp(data)).status).toBe(200);
    const before = await walletState(wallet.id);

    const messageId = await send(inputQueueUrl, data);
    await waitUntil(async () => ((await inboxRow(messageId)) ? true : undefined));
    await waitUntil(() => drained(inputQueueUrl));

    expect(await walletState(wallet.id)).toEqual(before);
    expect(await transactionsOf(data)).toHaveLength(1);
  }, 60_000);

  test('queue first: HTTP answers the replay, with idempotentReplay', async () => {
    const wallet = await createWallet('100.00');
    const data = betData(wallet);
    await send(inputQueueUrl, data);
    const [transaction] = await waitUntil(async () => {
      const rows = await transactionsOf(data);
      return rows.length > 0 ? rows : undefined;
    });
    await waitUntil(() => drained(inputQueueUrl));
    const before = await walletState(wallet.id);

    const response = await submitByHttp(data);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ transactionId: transaction!.id, idempotentReplay: true });
    expect(await walletState(wallet.id)).toEqual(before);
  }, 60_000);
});

describe('a process that dies between the commit and the ack', () => {
  test('leaves the message, whose redelivery duplicates nothing and ends acknowledged', async () => {
    const input = await createQueue('wager-transactions');
    const events = await createQueue('wagering-events');
    const dying = await startApp(
      instanceConfig({
        inputQueue: input.name,
        eventsQueue: events.name,
        publisher: false,
        visibilityTimeoutSeconds: 5,
        faults: [FaultPoint.CrashAfterCommit],
      }),
    );
    await dying.init();
    const wallet = await createWallet('100.00');
    const data = betData(wallet);

    const messageId = await send(input.url, data);
    await waitUntil(async () => ((await inboxRow(messageId)) ? true : undefined));
    await stop(dying);
    expect(await messagesLeft(input.url)).toBe(1);
    const afterCommit = await walletState(wallet.id);

    const survivor = await startApp(
      instanceConfig({ inputQueue: input.name, eventsQueue: events.name, publisher: false, visibilityTimeoutSeconds: 5 }),
    );
    await survivor.listen(0, '127.0.0.1');
    const survivorUrl = await survivor.getUrl();
    await waitUntil(() => drained(input.url), 30_000);

    expect(await inboxDuplicates(survivorUrl)).toBe(1);
    expect(await walletState(wallet.id)).toEqual(afterCommit);
    expect(afterCommit).toMatchObject({ balance_amount: '75.00', version: 2, entries: 2 });
    expect(await transactionsOf(data)).toHaveLength(1);
  }, 60_000);
});
