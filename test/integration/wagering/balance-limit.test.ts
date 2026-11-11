/**
 * The maximum balance (`CONTEXT.md` § Saldo máximo) end to end, against the
 * real PostgreSQL and the real LocalStack: a `WIN`, a `REFUND` or the
 * `ROLLBACK` of a `BET` that would take the balance past
 * `99999999999999999.99` ends `REJECTED` `BALANCE_LIMIT_EXCEEDED` — by HTTP
 * and by the queue — with no ledger entry, the balance and version untouched
 * and observed, and `WagerTransactionRejected` in the outbox; a credit up to
 * exactly the maximum is processed. The wallets reach those balances by wins
 * at the input ceiling, never by raw SQL. Every wallet passes the final ledger
 * invariant check.
 *
 * @packageDocumentation
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { SQL } from 'bun';
import { CreateQueueCommand, DeleteQueueCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { createApp } from '../../../src/app.ts';
import { loadConfig } from '../../../src/config.ts';
import { expectLedgerConsistent } from '../ledger-invariant.ts';
import { waitUntil } from '../../support/wait-until.ts';

type JsonObject = Record<string, unknown>;

interface TestWallet {
  id: string;
  playerId: string;
}

const INPUT_CEILING = '999999999999999.99';
/** The opening and 99 wins at the input ceiling: 0.99 short of the maximum. */
const NEAR_MAXIMUM = '99999999999999999.00';
/** Filling a wallet takes about a hundred submissions. */
const TEST_TIMEOUT_MS = 30_000;

let app: INestApplication;
let baseUrl: string;
let sql: SQL;
let sqs: SQSClient;
let inputQueueUrl: string;
const touchedWallets: string[] = [];

beforeAll(async () => {
  const config = loadConfig();
  sql = new SQL(config.databaseUrl);
  sqs = new SQSClient({
    endpoint: config.sqs.endpoint,
    region: config.sqs.region,
    credentials: { accessKeyId: config.sqs.accessKeyId, secretAccessKey: config.sqs.secretAccessKey },
  });
  const inputQueue = `wager-transactions-${Bun.randomUUIDv7().slice(-12)}.fifo`;
  const { QueueUrl } = await sqs.send(
    new CreateQueueCommand({ QueueName: inputQueue, Attributes: { FifoQueue: 'true' } }),
  );
  inputQueueUrl = QueueUrl!;
  app = await createApp({
    ...config,
    sqs: { ...config.sqs, wagerTransactionsQueue: inputQueue },
    outboxPublisher: { ...config.outboxPublisher, enabled: false },
    wagerTransactionsConsumer: { ...config.wagerTransactionsConsumer, enabled: true, waitTimeSeconds: 1 },
  });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
});

afterAll(async () => {
  await expectLedgerConsistent(sql, touchedWallets);
  await app?.close();
  await sqs?.send(new DeleteQueueCommand({ QueueUrl: inputQueueUrl })).catch(() => undefined);
  sqs?.destroy();
  await sql?.close();
});

function transactionOn(wallet: TestWallet, kind: string, amount: string, overrides: JsonObject = {}): JsonObject {
  return {
    providerId: 'provider-a',
    externalTransactionId: Bun.randomUUIDv7(),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind,
    money: { amount, currency: 'BRL' },
    ...overrides,
  };
}

async function submit(body: JsonObject): Promise<{ status: number; body: JsonObject }> {
  const response = await fetch(`${baseUrl}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': `key-${body.externalTransactionId}` },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as JsonObject };
}

async function processed(body: JsonObject): Promise<JsonObject> {
  const { status } = await submit(body);
  expect(status).toBe(200);
  return body;
}

/** A wallet opened at the input ceiling, with `bets` bets of 1.00 placed first, then filled by wins. */
async function walletNearMaximum(bets = 0): Promise<{ wallet: TestWallet; bets: JsonObject[] }> {
  const playerId = Bun.randomUUIDv7();
  const response = await fetch(`${baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, initialBalance: { amount: INPUT_CEILING, currency: 'BRL' } }),
  });
  expect(response.status).toBe(201);
  const { id } = (await response.json()) as { id: string };
  touchedWallets.push(id);
  const wallet = { id, playerId };
  const placed: JsonObject[] = [];
  for (let i = 0; i < bets; i++) placed.push(await processed(transactionOn(wallet, 'BET', '1.00')));
  for (let i = 0; i < 99; i++) await processed(transactionOn(wallet, 'WIN', INPUT_CEILING));
  // Wins of the bets back, so every wallet stands at the same balance.
  if (bets > 0) await processed(transactionOn(wallet, 'WIN', `${bets}.00`));
  return { wallet, bets: placed };
}

async function walletState(walletId: string): Promise<{ balance: string; version: number; entries: number }> {
  const [row] = await sql`
    select w.balance_amount::text as balance, w.version,
           (select count(*)::int from wallet_ledger_entries where wallet_id = w.id) as entries
      from wallets w where w.id = ${walletId}
  `;
  return row;
}

async function recorded(body: JsonObject): Promise<JsonObject | undefined> {
  const [row] = await sql`
    select t.id, t.status, t.failure_code, t.balance_after_amount::text as balance_after, t.wallet_version_observed,
           (select count(*)::int from wallet_ledger_entries e where e.transaction_id = t.id) as entries,
           (select array_agg(o.event_type order by o.event_type) from outbox_messages o
             where o.payload->'data'->>'transactionId' = t.id::text) as events
      from wager_transactions t
     where t.provider_id = 'provider-a' and t.external_transaction_id = ${body.externalTransactionId as string}
  `;
  return row;
}

function expectRejectedAtLimit(row: JsonObject | undefined, walletVersion: number): void {
  expect(row).toMatchObject({
    status: 'REJECTED',
    failure_code: 'BALANCE_LIMIT_EXCEEDED',
    balance_after: NEAR_MAXIMUM,
    wallet_version_observed: walletVersion,
    entries: 0,
    events: ['WagerTransactionRejected'],
  });
}

describe('a credit past the maximum balance, by HTTP', () => {
  test('a WIN: 422 REJECTED BALANCE_LIMIT_EXCEEDED, no entry, wallet untouched', async () => {
    const { wallet } = await walletNearMaximum();
    const before = await walletState(wallet.id);
    expect(before.balance).toBe(NEAR_MAXIMUM);
    const win = transactionOn(wallet, 'WIN', '1.00');

    const { status, body } = await submit(win);

    expect(status).toBe(422);
    expect(body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'BALANCE_LIMIT_EXCEEDED',
      balance: { amount: NEAR_MAXIMUM, currency: 'BRL' },
    });
    expect(await walletState(wallet.id)).toEqual(before);
    expectRejectedAtLimit(await recorded(win), before.version);
  }, TEST_TIMEOUT_MS);

  test.each(['REFUND', 'ROLLBACK'])('a %s of a BET: 422 REJECTED BALANCE_LIMIT_EXCEEDED, no entry, wallet untouched', async (kind) => {
    const { wallet, bets } = await walletNearMaximum(1);
    const before = await walletState(wallet.id);
    expect(before.balance).toBe(NEAR_MAXIMUM);
    const undo = transactionOn(wallet, kind, '1.00', { referenceExternalTransactionId: bets[0]!.externalTransactionId });

    const { status, body } = await submit(undo);

    expect(status).toBe(422);
    expect(body).toMatchObject({ status: 'REJECTED', failureCode: 'BALANCE_LIMIT_EXCEEDED' });
    expect(await walletState(wallet.id)).toEqual(before);
    expectRejectedAtLimit(await recorded(undo), before.version);
  }, TEST_TIMEOUT_MS);

  test('a WIN up to exactly the maximum: processed', async () => {
    const { wallet } = await walletNearMaximum();

    const { status, body } = await submit(transactionOn(wallet, 'WIN', '0.99'));

    expect(status).toBe(200);
    expect(body).toMatchObject({ status: 'PROCESSED', balance: { amount: '99999999999999999.99', currency: 'BRL' } });
    expect(await walletState(wallet.id)).toMatchObject({ balance: '99999999999999999.99', version: 101 });
  }, TEST_TIMEOUT_MS);
});

describe('a credit past the maximum balance, by the queue', () => {
  test('a WIN: REJECTED BALANCE_LIMIT_EXCEEDED, no entry, wallet untouched', async () => {
    const { wallet } = await walletNearMaximum();
    const before = await walletState(wallet.id);
    const win = transactionOn(wallet, 'WIN', '1.00');

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: inputQueueUrl,
        MessageBody: JSON.stringify({
          messageId: Bun.randomUUIDv7(),
          type: 'WagerTransactionRequested',
          occurredAt: new Date().toISOString(),
          data: { ...win, idempotencyKey: `key-${win.externalTransactionId}` },
        }),
        MessageGroupId: wallet.id,
        MessageDeduplicationId: Bun.randomUUIDv7(),
      }),
    );
    const row = await waitUntil(() => recorded(win), 30_000);

    expectRejectedAtLimit(row, before.version);
    expect(await walletState(wallet.id)).toEqual(before);
  }, TEST_TIMEOUT_MS);
});
