/**
 * `GET /metrics` end to end, against the real PostgreSQL: every metric of the
 * observability slice is exposed from the start, the zeros included, and the
 * submissions of the test move them — outcomes, replays, conflicts, refusals,
 * lock conflicts, latency, reconciliation divergences — while the outbox
 * gauges, read from the database on each scrape, show the events no publisher
 * took (the test apps run none), and the DLQ depth, read from SQS, shows what
 * waits in the DLQ.
 *
 * The test database is shared with the other test files: the checks compare
 * this app's counters before and after, and the outbox gauges only from below.
 *
 * @packageDocumentation
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { CreateQueueCommand, DeleteQueueCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { SQL } from 'bun';
import { createApp } from '../../../src/app.ts';
import { loadConfig } from '../../../src/config.ts';
import { excludeFromLedgerInvariant, expectLedgerConsistent } from '../ledger-invariant.ts';

type JsonObject = Record<string, unknown>;

interface TestWallet {
  id: string;
  playerId: string;
}

let app: INestApplication;
let baseUrl: string;
let sql: SQL;
const touchedWallets: string[] = [];

beforeAll(async () => {
  const config = loadConfig();
  app = await createApp(config);
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
  sql = new SQL(config.databaseUrl);
});

afterAll(async () => {
  await expectLedgerConsistent(sql, touchedWallets);
  await app?.close();
  await sql?.close();
});

async function scrape(): Promise<string> {
  const response = await fetch(`${baseUrl}/metrics`);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/plain');
  return response.text();
}

/** The value of one sample, by its name and exact labels; 0 when absent. */
function sample(text: string, name: string, labels: Record<string, string> = {}): number {
  const wanted = Object.entries(labels);
  for (const line of text.split('\n')) {
    const match = /^([a-zA-Z_:][\w:]*)(?:\{(.*)\})? (\S+)$/.exec(line);
    if (!match || match[1] !== name) continue;
    const found = Object.fromEntries([...(match[2] ?? '').matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
    if (Object.keys(found).length !== wanted.length) continue;
    if (wanted.every(([key, value]) => found[key] === value)) return Number(match[3]);
  }
  return 0;
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
  return { id, playerId };
}

function betOn(wallet: TestWallet, amount = '25.00'): JsonObject {
  return {
    providerId: 'provider-metrics',
    externalTransactionId: Bun.randomUUIDv7(),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount, currency: 'BRL' },
  };
}

function submit(body: JsonObject, idempotencyKey = `key-${body.externalTransactionId}`): Promise<Response> {
  return fetch(`${baseUrl}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
    body: JSON.stringify(body),
  });
}

const HTTP_BET = { channel: 'HTTP', kind: 'BET' };

describe('GET /metrics', () => {
  test('exposes every metric of the slice, the ones still at zero included', async () => {
    const text = await scrape();

    for (const [name, type] of [
      ['wager_transactions_total', 'counter'],
      ['wager_transaction_idempotent_replays_total', 'counter'],
      ['wager_transaction_idempotency_conflicts_total', 'counter'],
      ['rejected_submissions_total', 'counter'],
      ['inbox_duplicates_total', 'counter'],
      ['lock_conflicts_total', 'counter'],
      ['outbox_pending', 'gauge'],
      ['outbox_lag_seconds', 'gauge'],
      ['wager_transaction_processing_seconds', 'histogram'],
      ['reconciliation_divergences_total', 'counter'],
      ['wager_transactions_consumer_retries_total', 'counter'],
      ['wager_transactions_dlq_messages_total', 'counter'],
      ['wager_transactions_dlq_depth', 'gauge'],
      ['outbox_publish_retries_total', 'counter'],
      ['outbox_stuck_messages', 'gauge'],
      ['pending_reference_retries_total', 'counter'],
    ]) {
      expect(text).toContain(`# TYPE ${name} ${type}`);
    }
    // The known series exist at the start: a sample line, not only the TYPE.
    expect(text).toMatch(/^wager_transactions_total\{kind="WIN",status="REJECTED",channel="QUEUE"\} \d+$/m);
    expect(text).toMatch(/^wager_transactions_total\{kind="REFUND",status="PROCESSED",channel="WORKER"\} \d+$/m);
    expect(text).toMatch(/^lock_conflicts_total\{reason="serialization_failure"\} \d+$/m);
    expect(text).toMatch(/^rejected_submissions_total\{failure_code="MESSAGE_ID_CONFLICT",channel="QUEUE"\} \d+$/m);
    expect(text).toMatch(/^inbox_duplicates_total 0$/m);
    expect(text).toMatch(/^reconciliation_divergences_total \d+$/m);
  });

  test('a processed and a rejected bet, then a replay: counted by kind, status and channel, latency observed', async () => {
    const before = await scrape();
    const wallet = await createWallet('30.00');
    touchedWallets.push(wallet.id);
    const processed = betOn(wallet);

    expect((await submit(processed)).status).toBe(200);
    expect((await submit(betOn(wallet, '20.00'))).status).toBe(422);
    expect((await submit(processed)).status).toBe(200);

    const after = await scrape();
    const delta = (name: string, labels: Record<string, string> = {}) =>
      sample(after, name, labels) - sample(before, name, labels);
    expect(delta('wager_transactions_total', { ...HTTP_BET, status: 'PROCESSED' })).toBe(1);
    expect(delta('wager_transactions_total', { ...HTTP_BET, status: 'REJECTED' })).toBe(1);
    expect(delta('wager_transaction_idempotent_replays_total', { channel: 'HTTP' })).toBe(1);
    expect(delta('wager_transaction_processing_seconds_count', { ...HTTP_BET, outcome: 'settled' })).toBe(3);
  });

  test('an idempotency conflict and a submission not admitted: counted, the second by code', async () => {
    const before = await scrape();
    const wallet = await createWallet('100.00');
    touchedWallets.push(wallet.id);
    const body = betOn(wallet);
    await submit(body);

    expect((await submit({ ...body, money: { amount: '1.00', currency: 'BRL' } })).status).toBe(409);
    expect((await submit({ ...betOn(wallet), walletId: Bun.randomUUIDv7() })).status).toBe(422);

    const after = await scrape();
    const delta = (name: string, labels: Record<string, string>) =>
      sample(after, name, labels) - sample(before, name, labels);
    expect(delta('wager_transaction_idempotency_conflicts_total', { channel: 'HTTP' })).toBe(1);
    expect(delta('rejected_submissions_total', { failure_code: 'IDEMPOTENCY_CONFLICT', channel: 'HTTP' })).toBe(1);
    expect(delta('rejected_submissions_total', { failure_code: 'WALLET_NOT_FOUND', channel: 'HTTP' })).toBe(1);
    // Timed too, by how they ended.
    expect(delta('wager_transaction_processing_seconds_count', { ...HTTP_BET, outcome: 'not_admitted' })).toBe(2);
  });

  test('the wallet locked by another session beyond the lock_timeout: a lock conflict by reason', async () => {
    const before = await scrape();
    const wallet = await createWallet('100.00');
    touchedWallets.push(wallet.id);
    const holder = await sql.reserve();
    try {
      await holder`begin`;
      await holder`select id from wallets where id = ${wallet.id} for update`;
      expect((await submit(betOn(wallet))).status).toBe(503);
    } finally {
      await holder`rollback`;
      holder.release();
    }

    const after = await scrape();
    expect(
      sample(after, 'lock_conflicts_total', { reason: 'lock_timeout' }) -
        sample(before, 'lock_conflicts_total', { reason: 'lock_timeout' }),
    ).toBe(1);
    // The error path is timed, with its outcome: past the 2 s lock timeout.
    const transient = { ...HTTP_BET, outcome: 'transient' };
    expect(
      sample(after, 'wager_transaction_processing_seconds_count', transient) -
        sample(before, 'wager_transaction_processing_seconds_count', transient),
    ).toBe(1);
    expect(
      sample(after, 'wager_transaction_processing_seconds_bucket', { ...transient, le: '1' }) -
        sample(before, 'wager_transaction_processing_seconds_bucket', { ...transient, le: '1' }),
    ).toBe(0);
  }, 10_000);

  test('a reconciliation divergence: counted', async () => {
    const before = await scrape();
    const wallet = await createWallet('100.00');
    // Divergent on purpose: out of the final invariant check of the run.
    excludeFromLedgerInvariant(wallet.id);
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update wallets set balance_amount = 90.00 where id = ${wallet.id}`;
    });

    const response = await fetch(`${baseUrl}/wallets/${wallet.id}/reconciliation`, { method: 'POST' });

    expect(response.status).toBe(200);
    const after = await scrape();
    expect(sample(after, 'reconciliation_divergences_total') - sample(before, 'reconciliation_divergences_total')).toBe(1);
  });

  test('events no publisher took: outbox_pending and outbox_lag_seconds read them from the database', async () => {
    const wallet = await createWallet('100.00');
    touchedWallets.push(wallet.id);
    expect((await submit(betOn(wallet))).status).toBe(200);
    const [row] = await sql`
      select count(*)::int as pending,
             extract(epoch from now() - min(occurred_at))::float8 as lag
        from outbox_messages where published_at is null
    `;

    const text = await scrape();

    expect(sample(text, 'outbox_pending')).toBeGreaterThanOrEqual(row.pending);
    expect(sample(text, 'outbox_pending')).toBeGreaterThan(0);
    expect(sample(text, 'outbox_lag_seconds')).toBeGreaterThanOrEqual(row.lag);
    expect(sample(text, 'outbox_lag_seconds')).toBeGreaterThan(0);
  });

  test('messages waiting in the DLQ: wager_transactions_dlq_depth reads them from SQS on the scrape', async () => {
    const config = loadConfig();
    const sqs = new SQSClient({
      endpoint: config.sqs.endpoint,
      region: config.sqs.region,
      credentials: { accessKeyId: config.sqs.accessKeyId, secretAccessKey: config.sqs.secretAccessKey },
    });
    const dlqName = `metrics-dlq-${Bun.randomUUIDv7()}.fifo`;
    const { QueueUrl } = await sqs.send(
      new CreateQueueCommand({ QueueName: dlqName, Attributes: { FifoQueue: 'true' } }),
    );
    const dlqApp = await createApp({ ...config, sqs: { ...config.sqs, wagerTransactionsDlq: dlqName } });
    try {
      await dlqApp.listen(0, '127.0.0.1');
      const url = await dlqApp.getUrl();
      const depth = async () => sample(await (await fetch(`${url}/metrics`)).text(), 'wager_transactions_dlq_depth');
      expect(await depth()).toBe(0);

      for (const id of ['a', 'b']) {
        await sqs.send(
          new SendMessageCommand({ QueueUrl, MessageBody: '{}', MessageGroupId: 'g', MessageDeduplicationId: id }),
        );
      }

      expect(await depth()).toBe(2);
    } finally {
      await dlqApp.close();
      await sqs.send(new DeleteQueueCommand({ QueueUrl })).catch(() => undefined);
      sqs.destroy();
    }
  });
});
