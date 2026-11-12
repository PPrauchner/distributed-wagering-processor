/**
 * The consumer of `wager-transactions.fifo` on its failure path and at
 * shutdown, end to end against the real PostgreSQL and the real LocalStack: a
 * transient failure comes back with its backoff and is processed later; five
 * receives of it end with no outcome in the DLQ, as `INFRA_RETRIES_EXHAUSTED`,
 * and the key stays free for the DLQ redrive or an HTTP resend; a
 * permanent error ends `FAILED` in the DLQ, with `WagerTransactionFailed` in
 * the outbox, and its redelivery has no effect;
 * submissions not admitted go to the DLQ with their `failureCode` and a
 * `rejected_submissions` row — a `BET` sent before its wallet exists only once
 * its receives run out —; a batch keeps the order of its FIFO groups, a retry
 * included; a real process given `SIGTERM` with messages in
 * progress loses and duplicates none. Every input queue has a DLQ of its own,
 * with the redrive of the Compose (`maxReceiveCount` 6), and a random suffix;
 * the backoff ceiling is 1 s, so five receives take seconds. Waits by
 * condition, never by a fixed sleep. Ends checking the ledger invariant of
 * every wallet it touched.
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
import { UNIT_OF_WORK, type UnitOfWork } from '../../../src/shared/application/unit-of-work.ts';
import type { OutboxRepositories } from '../../../src/messaging/application/outbox-repository.ts';
import type { WageringRepositories } from '../../../src/wagering/application/wager-transaction-repository.ts';
import { RecordOpening } from '../../../src/wagering/application/record-opening.ts';
import { CreateWallet } from '../../../src/wallet/application/create-wallet.ts';
import type { WalletRepositories } from '../../../src/wallet/application/wallet-repository.ts';
import { expectLedgerConsistent } from '../ledger-invariant.ts';
import { waitUntil } from '../../support/wait-until.ts';

type JsonObject = Record<string, unknown>;

interface TestWallet {
  id: string;
  playerId: string;
}

interface QueuePair {
  name: string;
  url: string;
  dlqName: string;
  dlqUrl: string;
}

interface DeadLetter {
  body: JsonObject | string;
  failureCode: string | undefined;
}

const CONSUMER = 'wager-transactions-consumer';
/** The redrive of the Compose: the safety net past the consumer's five receives. */
const MAX_RECEIVE_COUNT = '6';

const apps: INestApplication[] = [];
const queueUrls: string[] = [];
const touchedWallets: string[] = [];
const letters = new Map<string, DeadLetter[]>();
let config: AppConfig;
let sql: SQL;
let sqs: SQSClient;

/** The main instance: HTTP and the consumer of its own input queue. */
let app: INestApplication;
let baseUrl: string;
let main: QueuePair;

beforeAll(async () => {
  config = loadConfig();
  sql = new SQL(config.databaseUrl);
  sqs = new SQSClient({
    endpoint: config.sqs.endpoint,
    region: config.sqs.region,
    credentials: { accessKeyId: config.sqs.accessKeyId, secretAccessKey: config.sqs.secretAccessKey },
  });
  main = await createQueuePair();
  app = await startApp(instanceConfig(main));
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
});

afterAll(async () => {
  await expectLedgerConsistent(sql, touchedWallets);
  await Promise.all(apps.map((instance) => instance.close()));
  await Promise.all(queueUrls.map((QueueUrl) => sqs.send(new DeleteQueueCommand({ QueueUrl })).catch(() => undefined)));
  sqs?.destroy();
  await sql?.close();
});

function instanceConfig(queues: QueuePair, faults: FaultPoint[] = []): AppConfig {
  return {
    ...config,
    faultPoints: faults,
    sqs: { ...config.sqs, wagerTransactionsQueue: queues.name, wagerTransactionsDlq: queues.dlqName },
    wagerTransactionsConsumer: {
      ...config.wagerTransactionsConsumer,
      enabled: true,
      waitTimeSeconds: 1,
      visibilityTimeoutSeconds: 5,
      maxReceives: 5,
      retryMaxSeconds: 1,
    },
  };
}

async function startApp(appConfig: AppConfig): Promise<INestApplication> {
  const instance = await createApp(appConfig);
  apps.push(instance);
  return instance;
}

/** An input queue with its own DLQ, by the redrive of the Compose. */
async function createQueuePair(): Promise<QueuePair> {
  const suffix = Bun.randomUUIDv7().slice(-12);
  const dlqName = `wager-transactions-dlq-${suffix}.fifo`;
  const { QueueUrl: dlqUrl } = await sqs.send(
    new CreateQueueCommand({ QueueName: dlqName, Attributes: { FifoQueue: 'true' } }),
  );
  const { Attributes = {} } = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }),
  );
  const name = `wager-transactions-${suffix}.fifo`;
  const { QueueUrl: url } = await sqs.send(
    new CreateQueueCommand({
      QueueName: name,
      Attributes: {
        FifoQueue: 'true',
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: Attributes.QueueArn, maxReceiveCount: MAX_RECEIVE_COUNT }),
      },
    }),
  );
  queueUrls.push(url!, dlqUrl!);
  return { name, url: url!, dlqName, dlqUrl: dlqUrl! };
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

/** Creates the wallet under an id chosen beforehand, as if the provider created it meanwhile. */
async function createWalletWithId(wallet: TestWallet, amount: string): Promise<void> {
  let first = true;
  const generateId = () => {
    if (!first) return Bun.randomUUIDv7();
    first = false;
    return wallet.id;
  };
  const unitOfWork = app.get<UnitOfWork<WalletRepositories & WageringRepositories & OutboxRepositories>>(UNIT_OF_WORK);
  await new CreateWallet(unitOfWork, new RecordOpening(() => Bun.randomUUIDv7()), generateId, { lockConflict: () => undefined }).execute({
    playerId: wallet.playerId,
    initialBalance: { amount, currency: 'BRL' },
  });
  touchedWallets.push(wallet.id);
}

function betData(wallet: TestWallet, amount = '25.00', overrides: JsonObject = {}): JsonObject {
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
    ...overrides,
  };
}

/** Sends a §10 envelope — or any body — as a new SQS message. */
async function send(
  queueUrl: string,
  data: JsonObject,
  options: { messageId?: string; body?: string; groupId?: string } = {},
): Promise<string> {
  const messageId = options.messageId ?? Bun.randomUUIDv7();
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody:
        options.body ??
        JSON.stringify({ messageId, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data }),
      MessageGroupId: options.groupId ?? (typeof data.walletId === 'string' ? data.walletId : Bun.randomUUIDv7()),
      MessageDeduplicationId: Bun.randomUUIDv7(),
    }),
  );
  return messageId;
}

async function messagesLeft(queueUrl: string): Promise<number> {
  const { Attributes = {} } = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return Number(Attributes.ApproximateNumberOfMessages) + Number(Attributes.ApproximateNumberOfMessagesNotVisible);
}

async function drained(queueUrl: string): Promise<true | undefined> {
  return (await messagesLeft(queueUrl)) === 0 ? true : undefined;
}

/** Receives — and deletes — the DLQ's messages until one matches. */
async function deadLetter(dlqUrl: string, matches: (letter: DeadLetter) => boolean): Promise<DeadLetter> {
  const seen = letters.get(dlqUrl) ?? [];
  letters.set(dlqUrl, seen);
  return waitUntil(async () => {
    const { Messages = [] } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: dlqUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        MessageAttributeNames: ['All'],
      }),
    );
    for (const message of Messages) {
      let body: JsonObject | string;
      try {
        body = JSON.parse(message.Body!) as JsonObject;
      } catch {
        body = message.Body!;
      }
      seen.push({ body, failureCode: message.MessageAttributes?.failureCode?.StringValue });
    }
    if (Messages.length > 0) {
      await sqs.send(
        new DeleteMessageBatchCommand({
          QueueUrl: dlqUrl,
          Entries: Messages.map((message, index) => ({ Id: `${index}`, ReceiptHandle: message.ReceiptHandle! })),
        }),
      );
    }
    return seen.find(matches);
  }, 45_000);
}

function withMessageId(messageId: string): (letter: DeadLetter) => boolean {
  return (letter) => typeof letter.body === 'object' && letter.body.messageId === messageId;
}

interface TransactionRow {
  id: string;
  status: string;
  failure_code: string | null;
}

async function transactionsOf(data: JsonObject): Promise<TransactionRow[]> {
  const rows: TransactionRow[] = await sql`
    select id, status, failure_code from wager_transactions
     where provider_id = ${data.providerId as string} and external_transaction_id = ${data.externalTransactionId as string}
  `;
  // A plain array: the result's own fields (count, command) would fail toMatchObject.
  return [...rows];
}

async function oneTransactionOf(data: JsonObject): Promise<TransactionRow> {
  const [row] = await waitUntil(async () => {
    const rows = await transactionsOf(data);
    return rows.length > 0 ? rows : undefined;
  });
  return row!;
}

async function inboxRow(messageId: string): Promise<{ payload_hash: string } | undefined> {
  const [row] = await sql`
    select payload_hash from inbox_messages where consumer_name = ${CONSUMER} and message_id = ${messageId}
  `;
  return row;
}

async function inboxRowsOf(messageId: string): Promise<{ processed: boolean }[]> {
  return [
    ...(await sql`
      select processed_at is not null as processed from inbox_messages
       where consumer_name = ${CONSUMER} and message_id = ${messageId}
    `),
  ];
}

async function outboxIds(walletId: string): Promise<string[]> {
  const rows = await sql`select id::text from outbox_messages where wallet_id = ${walletId} order by id`;
  return rows.map((row: { id: string }) => row.id);
}

async function rejectedRows(messageId: string): Promise<{ failure_code: string; channel: string }[]> {
  return [...(await sql`select failure_code, channel from rejected_submissions where message_id = ${messageId}`)];
}

async function walletState(walletId: string): Promise<{ balance_amount: string; version: number }> {
  const [row] = await sql`select balance_amount::text, version from wallets where id = ${walletId}`;
  return row;
}

async function counter(name: string, failureCode: string, url = baseUrl): Promise<number> {
  const text = await (await fetch(`${url}/metrics`)).text();
  const line = text.split('\n').find((row) => row.startsWith(`${name}{failure_code="${failureCode}"} `));
  return line === undefined ? 0 : Number(line.split(' ')[1]);
}

const retries = (failureCode: string, url?: string) =>
  counter('wager_transactions_consumer_retries_total', failureCode, url);
const deadLettered = (failureCode: string) => counter('wager_transactions_dlq_messages_total', failureCode);

/**
 * Holds the wallet's row lock — the one the use case waits for, but not the
 * key share an insert's foreign key takes — until `release` resolves.
 */
async function holdWalletLock(walletId: string, release: Promise<void>): Promise<{ released: Promise<void> }> {
  let held!: () => void;
  const locked = new Promise<void>((resolve) => (held = resolve));
  const released = sql.begin(async (tx) => {
    await tx`select id from wallets where id = ${walletId} for no key update`;
    held();
    await release;
  });
  await locked;
  return { released: released.then(() => undefined) };
}

async function ledgerEntriesOf(transactionId: string): Promise<number> {
  const [row] = await sql`select count(*)::int as entries from wallet_ledger_entries where transaction_id = ${transactionId}`;
  return row.entries;
}

/**
 * Sends the message with its wallet locked until its five receives run out,
 * then frees the wallet once it is in the DLQ and gone from the input queue.
 */
async function exhaustRetries(data: JsonObject): Promise<{ messageId: string; letter: DeadLetter }> {
  let release!: () => void;
  const lock = await holdWalletLock(data.walletId as string, new Promise((resolve) => (release = resolve)));
  const messageId = await send(main.url, data);
  const letter = await deadLetter(main.dlqUrl, withMessageId(messageId));
  // The rejected row is recorded after the DLQ send, before the ack.
  await waitUntil(() => drained(main.url));
  release();
  await lock.released;
  return { messageId, letter };
}

describe('a transient failure', () => {
  test('the wallet locked past 2 s: the message comes back with its backoff and is processed later, once', async () => {
    const wallet = await createWallet('100.00');
    const data = betData(wallet);
    const retriesBefore = await retries('TRANSIENT_LOCK_TIMEOUT');
    let release!: () => void;
    const lock = await holdWalletLock(wallet.id, new Promise((resolve) => (release = resolve)));

    await send(main.url, data);
    await waitUntil(async () => ((await retries('TRANSIENT_LOCK_TIMEOUT')) > retriesBefore ? true : undefined));
    expect(await transactionsOf(data)).toEqual([]);
    release();
    await lock.released;

    const transaction = await oneTransactionOf(data);
    await waitUntil(() => drained(main.url));
    expect(transaction.status).toBe('PROCESSED');
    expect(await transactionsOf(data)).toHaveLength(1);
    expect(await walletState(wallet.id)).toEqual({ balance_amount: '75.00', version: 2 });
  }, 60_000);

  test('five receives of it: no outcome — the DLQ with INFRA_RETRIES_EXHAUSTED, a rejected row, no transaction, no inbox row', async () => {
    const wallet = await createWallet('100.00');
    const data = betData(wallet);

    const { messageId, letter } = await exhaustRetries(data);

    expect(letter.failureCode).toBe('INFRA_RETRIES_EXHAUSTED');
    expect(await rejectedRows(messageId)).toEqual([{ failure_code: 'INFRA_RETRIES_EXHAUSTED', channel: 'QUEUE' }]);
    expect(await transactionsOf(data)).toEqual([]);
    expect(await inboxRow(messageId)).toBeUndefined();
    expect(await walletState(wallet.id)).toEqual({ balance_amount: '100.00', version: 1 });
  }, 90_000);

  test('once the wallet is free, the message from the DLQ sent again is PROCESSED, with exactly one ledger entry', async () => {
    const wallet = await createWallet('100.00');
    const data = betData(wallet);
    const { messageId } = await exhaustRetries(data);

    // The same messageId and body; a new deduplication id, past the FIFO window.
    await send(main.url, data, { messageId });
    const transaction = await oneTransactionOf(data);
    await waitUntil(() => drained(main.url));

    expect(transaction.status).toBe('PROCESSED');
    expect(await transactionsOf(data)).toHaveLength(1);
    expect(await ledgerEntriesOf(transaction.id)).toBe(1);
    expect(await inboxRow(messageId)).toBeDefined();
    expect(await walletState(wallet.id)).toEqual({ balance_amount: '75.00', version: 2 });
    await expectLedgerConsistent(sql, [wallet.id]);
  }, 90_000);

  test('once the wallet is free, the same key and payload by HTTP are applied, not a 500 replay', async () => {
    const wallet = await createWallet('100.00');
    const data = betData(wallet);
    await exhaustRetries(data);

    const { idempotencyKey, ...body } = data;
    const response = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey as string },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(200);
    const [transaction] = await transactionsOf(data);
    expect(transaction).toMatchObject({ status: 'PROCESSED' });
    expect(await ledgerEntriesOf(transaction!.id)).toBe(1);
    expect(await walletState(wallet.id)).toEqual({ balance_amount: '75.00', version: 2 });
    await expectLedgerConsistent(sql, [wallet.id]);
  }, 90_000);
});

describe('a permanent error', () => {
  test('ends FAILED with the classifier code, in the DLQ with it; a redelivery of the messageId has no second effect', async () => {
    const queues = await createQueuePair();
    const faulty = await startApp(instanceConfig(queues, [FaultPoint.InvariantViolationBeforeCommit]));
    await faulty.init();
    const wallet = await createWallet('100.00');
    const data = betData(wallet);
    const outboxBefore = await outboxIds(wallet.id);

    const messageId = await send(queues.url, data);
    const letter = await deadLetter(queues.dlqUrl, withMessageId(messageId));
    await waitUntil(() => drained(queues.url));

    expect(letter.failureCode).toBe('INFRA_INVARIANT_VIOLATION');
    const [failed] = await transactionsOf(data);
    expect(failed).toMatchObject({ status: 'FAILED', failure_code: 'INFRA_INVARIANT_VIOLATION' });
    expect(await rejectedRows(messageId)).toEqual([]);
    // Atomicity: the first unit of work left no event; the second one — the
    // FAILED write — left only WagerTransactionFailed, and the inbox row, processed.
    expect(await outboxIds(wallet.id)).toHaveLength(outboxBefore.length + 1);
    expect(await eventTypesOf(failed!.id)).toEqual(['WagerTransactionFailed']);
    expect(await inboxRowsOf(messageId)).toEqual([{ processed: true }]);

    await send(queues.url, data, { messageId });
    await waitUntil(() => drained(queues.url));
    expect(await transactionsOf(data)).toHaveLength(1);
    expect(await eventTypesOf(failed!.id)).toEqual(['WagerTransactionFailed']);
    expect(await walletState(wallet.id)).toEqual({ balance_amount: '100.00', version: 1 });
  }, 60_000);
});

describe('a submission not admitted', () => {
  test('an invalid payload goes straight to the DLQ with INVALID_PAYLOAD and a rejected row of the queue channel', async () => {
    const wallet = await createWallet('100.00');
    const data = betData(wallet, '25.00', { money: 25 });
    const before = await deadLettered('INVALID_PAYLOAD');

    const messageId = await send(main.url, data);
    const letter = await deadLetter(main.dlqUrl, withMessageId(messageId));
    await waitUntil(() => drained(main.url));

    expect(letter.failureCode).toBe('INVALID_PAYLOAD');
    expect(await rejectedRows(messageId)).toEqual([{ failure_code: 'INVALID_PAYLOAD', channel: 'QUEUE' }]);
    expect(await transactionsOf(data)).toEqual([]);
    expect(await deadLettered('INVALID_PAYLOAD')).toBe(before + 1);
  }, 60_000);

  test('a BET sent before its wallet exists is retried, and PROCESSED once the wallet is created in time', async () => {
    const wallet = { id: Bun.randomUUIDv7(), playerId: Bun.randomUUIDv7() };
    const data = betData(wallet);
    const retriesBefore = await retries('WALLET_NOT_FOUND');

    const messageId = await send(main.url, data);
    await waitUntil(async () => ((await retries('WALLET_NOT_FOUND')) > retriesBefore ? true : undefined));
    await createWalletWithId(wallet, '100.00');

    const transaction = await oneTransactionOf(data);
    await waitUntil(() => drained(main.url));
    expect(transaction.status).toBe('PROCESSED');
    expect(await rejectedRows(messageId)).toEqual([]);
    expect(await walletState(wallet.id)).toEqual({ balance_amount: '75.00', version: 2 });
  }, 60_000);

  test('a wallet never created: after five receives, the DLQ with WALLET_NOT_FOUND, a rejected row and no transaction', async () => {
    const data = betData({ id: Bun.randomUUIDv7(), playerId: Bun.randomUUIDv7() });

    const messageId = await send(main.url, data);
    const letter = await deadLetter(main.dlqUrl, withMessageId(messageId));
    await waitUntil(() => drained(main.url));

    expect(letter.failureCode).toBe('WALLET_NOT_FOUND');
    expect(await rejectedRows(messageId)).toEqual([{ failure_code: 'WALLET_NOT_FOUND', channel: 'QUEUE' }]);
    expect(await transactionsOf(data)).toEqual([]);
  }, 60_000);

  test('the same messageId with another payload: the DLQ with MESSAGE_ID_CONFLICT, and the first outcome intact', async () => {
    const wallet = await createWallet('100.00');
    const data = betData(wallet);
    const messageId = await send(main.url, data);
    await oneTransactionOf(data);
    await waitUntil(() => drained(main.url));
    const before = await walletState(wallet.id);

    const other = betData(wallet, '10.00');
    await send(main.url, other, { messageId });
    const letter = await deadLetter(main.dlqUrl, (candidate) =>
      withMessageId(messageId)(candidate) && (candidate.body as { data: JsonObject }).data.externalTransactionId === other.externalTransactionId,
    );
    await waitUntil(() => drained(main.url));

    expect(letter.failureCode).toBe('MESSAGE_ID_CONFLICT');
    expect(await rejectedRows(messageId)).toEqual([{ failure_code: 'MESSAGE_ID_CONFLICT', channel: 'QUEUE' }]);
    expect(await transactionsOf(data)).toMatchObject([{ status: 'PROCESSED' }]);
    expect(await transactionsOf(other)).toEqual([]);
    expect(await walletState(wallet.id)).toEqual(before);
  }, 60_000);

  test('an idempotency conflict, an external id conflict and an OPENING go straight to the DLQ with their code', async () => {
    const wallet = await createWallet('100.00');
    const first = betData(wallet);
    await send(main.url, first);
    await oneTransactionOf(first);
    await waitUntil(() => drained(main.url));

    const cases: [JsonObject, string][] = [
      [{ ...first, money: { amount: '5.00', currency: 'BRL' } }, 'IDEMPOTENCY_CONFLICT'],
      [{ ...betData(wallet), externalTransactionId: first.externalTransactionId }, 'EXTERNAL_ID_CONFLICT'],
      [betData(wallet, '25.00', { kind: 'OPENING' }), 'INTERNAL_KIND_NOT_ALLOWED'],
    ];
    for (const [data, failureCode] of cases) {
      const messageId = await send(main.url, data);
      const letter = await deadLetter(main.dlqUrl, withMessageId(messageId));
      // The row is recorded after the DLQ send, before the ack.
      await waitUntil(() => drained(main.url));
      expect(letter.failureCode).toBe(failureCode);
      expect(await rejectedRows(messageId)).toEqual([{ failure_code: failureCode, channel: 'QUEUE' }]);
    }
    expect(await walletState(wallet.id)).toEqual({ balance_amount: '75.00', version: 2 });
  }, 60_000);
});

async function eventTypesOf(transactionId: string): Promise<string[]> {
  const rows = await sql`select event_type from outbox_messages where payload->>'causationId' = ${transactionId}`;
  return rows.map((row: { event_type: string }) => row.event_type);
}

/**
 * Starts a consumer on a queue the messages are already in, so its first
 * receive brings them in one batch; HTTP on a port of its own, for its metrics.
 */
async function consumerOn(queues: QueuePair): Promise<string> {
  const instance = await startApp(instanceConfig(queues));
  await instance.listen(0, '127.0.0.1');
  return instance.getUrl();
}

describe('the order of a FIFO group within a batch', () => {
  test('a BET and its ROLLBACK in the same batch and group: the ROLLBACK is PROCESSED at once, never PENDING_REFERENCE', async () => {
    const queues = await createQueuePair();
    const wallet = await createWallet('100.00');
    const bet = betData(wallet);
    const rollback = betData(wallet, '25.00', {
      kind: 'ROLLBACK',
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    await send(queues.url, bet);
    await send(queues.url, rollback);

    await consumerOn(queues);
    const settled = await oneTransactionOf(rollback);
    await waitUntil(() => drained(queues.url));

    expect(settled.status).toBe('PROCESSED');
    expect(await eventTypesOf(settled.id)).not.toContain('WagerTransactionPendingReference');
    expect(await transactionsOf(bet)).toMatchObject([{ status: 'PROCESSED' }]);
    expect(await walletState(wallet.id)).toEqual({ balance_amount: '100.00', version: 3 });
    await expectLedgerConsistent(sql, [wallet.id]);
  }, 60_000);

  test('the first of the group goes to a retry: the next one of the group is not processed before it', async () => {
    const queues = await createQueuePair();
    const wallet = await createWallet('100.00');
    // The next one is of another, unlocked wallet, in the same group: only the
    // group's order can hold it back while the first one waits for the lock.
    const other = await createWallet('100.00');
    const first = betData(wallet, '80.00');
    const next = betData(other, '30.00');
    let release!: () => void;
    const lock = await holdWalletLock(wallet.id, new Promise((resolve) => (release = resolve)));
    await send(queues.url, first);
    await send(queues.url, next, { groupId: wallet.id });

    const url = await consumerOn(queues);
    await waitUntil(async () => ((await retries('TRANSIENT_LOCK_TIMEOUT', url)) > 0 ? true : undefined));
    expect(await transactionsOf(next)).toEqual([]);
    release();
    await lock.released;

    await oneTransactionOf(next);
    await waitUntil(() => drained(queues.url));
    expect(await transactionsOf(first)).toMatchObject([{ status: 'PROCESSED' }]);
    expect(await transactionsOf(next)).toMatchObject([{ status: 'PROCESSED' }]);
    const [order] = await sql`
      select (select created_at from wager_transactions where external_transaction_id = ${first.externalTransactionId as string})
           < (select created_at from wager_transactions where external_transaction_id = ${next.externalTransactionId as string}) as in_order
    `;
    expect(order.in_order).toBe(true);
    expect(await walletState(wallet.id)).toEqual({ balance_amount: '20.00', version: 2 });
    expect(await walletState(other.id)).toEqual({ balance_amount: '70.00', version: 2 });
    await expectLedgerConsistent(sql, [wallet.id, other.id]);
  }, 60_000);
});

describe('SIGTERM with messages in progress', () => {
  test('the process ends in time, and every message ends processed exactly once, a new instance included', async () => {
    const queues = await createQueuePair();
    const wallets = await Promise.all(Array.from({ length: 10 }, () => createWallet('100.00')));
    const sent = wallets.flatMap((wallet) => [1, 2, 3, 4, 5].map(() => betData(wallet, '5.00')));
    const windows = process.platform === 'win32';
    const child = Bun.spawn(['bun', '--preload', './test/integration/support/shutdown-on-ipc.ts', 'src/main.ts'], {
      env: {
        ...process.env,
        PORT: '0',
        WAGER_TRANSACTIONS_CONSUMER_ENABLED: 'true',
        WAGER_TRANSACTIONS_QUEUE: queues.name,
        WAGER_TRANSACTIONS_DLQ: queues.dlqName,
        WAGER_TRANSACTIONS_WAIT_SECONDS: '1',
        WAGER_TRANSACTIONS_VISIBILITY_SECONDS: '5',
      },
      stdout: 'ignore',
      stderr: 'ignore',
      ipc: () => undefined,
    });

    for (const data of sent) await send(queues.url, data);
    await waitUntil(async () => {
      const [row] = await sql`
        select count(*)::int as settled from wager_transactions
         where wallet_id in ${sql(wallets.map((wallet) => wallet.id))} and kind = 'BET'
      `;
      return row.settled > 0 ? true : undefined;
    });
    const signalled = performance.now();
    if (windows) child.send('SIGTERM');
    else child.kill('SIGTERM');
    const ended = await waitUntil(
      async () => (child.exitCode !== null || child.signalCode !== null ? true : undefined),
      25_000,
      'the process ended',
    ).catch(() => false);
    if (!ended) child.kill('SIGKILL');
    expect(ended).toBe(true);
    expect(performance.now() - signalled).toBeLessThan(25_000);

    const survivor = await startApp(instanceConfig(queues));
    await survivor.init();
    await waitUntil(() => drained(queues.url), 45_000);

    for (const data of sent) expect(await transactionsOf(data)).toMatchObject([{ status: 'PROCESSED' }]);
    for (const wallet of wallets) expect(await walletState(wallet.id)).toEqual({ balance_amount: '75.00', version: 6 });
  }, 90_000);
});

describe('the metrics of the consumer', () => {
  test('the retries and the DLQ sends by failureCode moved in /metrics', async () => {
    expect(await retries('TRANSIENT_LOCK_TIMEOUT')).toBeGreaterThan(0);
    expect(await retries('WALLET_NOT_FOUND')).toBeGreaterThan(0);
    expect(await deadLettered('INFRA_RETRIES_EXHAUSTED')).toBeGreaterThan(0);
    expect(await deadLettered('WALLET_NOT_FOUND')).toBeGreaterThan(0);
    expect(await deadLettered('MESSAGE_ID_CONFLICT')).toBeGreaterThan(0);
  });
});
