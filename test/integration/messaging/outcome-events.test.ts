/**
 * The outbox written by the outcomes, end to end over HTTP against the real
 * PostgreSQL: the opening with a balance and the processed `BET` write
 * `WagerTransactionProcessed` and `WalletBalanceChanged`, the rejected `BET`
 * only `WagerTransactionRejected` — in the SQL transaction of the outcome, so a
 * permanent error after the outbox was written leaves none of them, and the
 * `FAILED` that follows writes only `WagerTransactionFailed`. Replays and
 * submissions not admitted write nothing. Ends checking the ledger
 * invariant of every wallet it touched.
 *
 * @packageDocumentation
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { SQL } from 'bun';
import { createApp } from '../../../src/app.ts';
import { loadConfig, type AppConfig } from '../../../src/config.ts';
import { FaultPoint } from '../../../src/shared/application/fault-injector.ts';
import { expectLedgerConsistent } from '../ledger-invariant.ts';

type JsonObject = Record<string, unknown>;

interface TestWallet {
  id: string;
  playerId: string;
}

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  wallet_id: string;
  payload: JsonObject;
}

const apps: INestApplication[] = [];
let config: AppConfig;
let baseUrl: string;
let sql: SQL;
const touchedWallets: string[] = [];

async function startApp(appConfig: AppConfig): Promise<string> {
  const app = await createApp(appConfig);
  await app.listen(0, '127.0.0.1');
  apps.push(app);
  return app.getUrl();
}

beforeAll(async () => {
  config = loadConfig();
  baseUrl = await startApp(config);
  sql = new SQL(config.databaseUrl);
});

afterAll(async () => {
  await expectLedgerConsistent(sql, touchedWallets);
  await Promise.all(apps.map((app) => app.close()));
  await sql?.close();
});

async function createWallet(amount: string, correlationId?: string): Promise<TestWallet> {
  const playerId = Bun.randomUUIDv7();
  const response = await fetch(`${baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(correlationId ? { 'x-correlation-id': correlationId } : {}) },
    body: JSON.stringify({ playerId, initialBalance: { amount, currency: 'BRL' } }),
  });
  expect(response.status).toBe(201);
  const { id } = (await response.json()) as { id: string };
  touchedWallets.push(id);
  return { id, playerId };
}

function betOn(wallet: TestWallet, amount = '25.00'): JsonObject {
  return {
    providerId: 'provider-a',
    externalTransactionId: Bun.randomUUIDv7(),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount, currency: 'BRL' },
  };
}

async function submit(body: JsonObject, url = baseUrl, correlationId = 'corr-bet'): Promise<JsonObject> {
  const response = await fetch(`${url}/wagering/transactions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `key-${body.externalTransactionId}`,
      'x-correlation-id': correlationId,
    },
    body: JSON.stringify(body),
  });
  return (await response.json()) as JsonObject;
}

async function outboxOf(walletId: string): Promise<OutboxRow[]> {
  return sql`
    select id, aggregate_id, event_type, wallet_id::text, payload
      from outbox_messages where wallet_id = ${walletId} order by occurred_at, event_type desc
  `;
}

async function openingId(walletId: string): Promise<string> {
  const [row] = await sql`select id from wager_transactions where wallet_id = ${walletId} and kind = 'OPENING'`;
  return row.id;
}

describe('the opening', () => {
  test('with a balance: WagerTransactionProcessed and WalletBalanceChanged, with the creation correlation id', async () => {
    const wallet = await createWallet('100.00', 'corr-open');
    const transactionId = await openingId(wallet.id);

    const rows = await outboxOf(wallet.id);

    expect(rows.map((row) => row.event_type).sort()).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    const processed = rows.find((row) => row.event_type === 'WagerTransactionProcessed')!;
    const changed = rows.find((row) => row.event_type === 'WalletBalanceChanged')!;
    expect(processed.id).toBe(processed.payload.eventId as string);
    expect(processed.payload).toMatchObject({
      eventType: 'WagerTransactionProcessed',
      aggregateId: transactionId,
      correlationId: 'corr-open',
      causationId: transactionId,
      version: 1,
      data: {
        transactionId,
        providerId: 'internal',
        walletId: wallet.id,
        playerId: wallet.playerId,
        kind: 'OPENING',
        money: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '100.00', currency: 'BRL' },
        walletVersion: 1,
      },
    });
    expect(changed.payload).toMatchObject({
      eventType: 'WalletBalanceChanged',
      aggregateId: wallet.id,
      correlationId: 'corr-open',
      causationId: transactionId,
      data: {
        walletId: wallet.id,
        transactionId,
        direction: 'CREDIT',
        money: { amount: '100.00', currency: 'BRL' },
        balanceBefore: { amount: '0.00', currency: 'BRL' },
        balanceAfter: { amount: '100.00', currency: 'BRL' },
        walletVersion: 1,
      },
    });
  });

  test('at zero: no opening, no event', async () => {
    const wallet = await createWallet('0.00');

    expect(await outboxOf(wallet.id)).toEqual([]);
  });
});

describe('the BET', () => {
  test('processed: WagerTransactionProcessed and WalletBalanceChanged, with the submission correlation id', async () => {
    const wallet = await createWallet('100.00');

    const result = await submit(betOn(wallet));

    const rows = (await outboxOf(wallet.id)).filter((row) => row.payload.causationId === result.transactionId);
    expect(rows.map((row) => row.event_type).sort()).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    for (const row of rows) {
      expect(row.wallet_id).toBe(wallet.id);
      expect(row.payload).toMatchObject({ correlationId: 'corr-bet', causationId: result.transactionId });
    }
    expect(rows.find((row) => row.event_type === 'WalletBalanceChanged')!.payload.data).toEqual({
      walletId: wallet.id,
      transactionId: result.transactionId,
      direction: 'DEBIT',
      money: { amount: '25.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '75.00', currency: 'BRL' },
      walletVersion: 2,
    });
    expect(rows.find((row) => row.event_type === 'WagerTransactionProcessed')!.payload.data).toMatchObject({
      transactionId: result.transactionId,
      kind: 'BET',
      balanceAfter: { amount: '75.00', currency: 'BRL' },
      walletVersion: 2,
    });
  });

  test('a walletId sent in upper case: every event carries the wallet in lower case', async () => {
    const wallet = await createWallet('100.00');

    const result = await submit({ ...betOn(wallet), walletId: wallet.id.toUpperCase() });

    const rows = (await outboxOf(wallet.id)).filter((row) => row.payload.causationId === result.transactionId);
    expect(rows.map((row) => row.event_type).sort()).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    for (const row of rows) expect(row.payload.data).toMatchObject({ walletId: wallet.id });
  });

  test('rejected by a business rule: only WagerTransactionRejected', async () => {
    const wallet = await createWallet('10.00');

    const result = await submit(betOn(wallet, '25.00'));

    expect(result.status).toBe('REJECTED');
    const rows = (await outboxOf(wallet.id)).filter((row) => row.payload.causationId === result.transactionId);
    expect(rows.map((row) => row.event_type)).toEqual(['WagerTransactionRejected']);
    expect(rows[0]!.aggregate_id).toBe(result.transactionId as string);
    expect(rows[0]!.payload.data).toMatchObject({
      transactionId: result.transactionId,
      failureCode: 'INSUFFICIENT_FUNDS',
      balanceAfter: { amount: '10.00', currency: 'BRL' },
      walletVersion: 1,
      rejectedAt: expect.any(String),
    });
  });

  test('a replay writes no event', async () => {
    const wallet = await createWallet('100.00');
    const body = betOn(wallet);
    await submit(body);
    const before = await outboxOf(wallet.id);

    const replay = await submit(body);

    expect(replay.idempotentReplay).toBe(true);
    expect(await outboxOf(wallet.id)).toEqual(before);
  });

  test('a permanent error after the outbox was written: FAILED, with only WagerTransactionFailed', async () => {
    const faultyUrl = await startApp({ ...config, faultPoints: [FaultPoint.InvariantViolationBeforeCommit] });
    const wallet = await createWallet('100.00');

    const result = await submit(betOn(wallet), faultyUrl);

    expect(result.status).toBe('FAILED');
    const rows = (await outboxOf(wallet.id)).filter((row) => row.payload.causationId === result.transactionId);
    expect(rows.map((row) => row.event_type)).toEqual(['WagerTransactionFailed']);
    expect(await outboxOf(wallet.id)).toHaveLength(3);
  });

  test('a submission not admitted writes no event', async () => {
    const wallet = { id: Bun.randomUUIDv7(), playerId: Bun.randomUUIDv7() };

    const result = await submit(betOn(wallet));

    expect(result.failureCode).toBe('WALLET_NOT_FOUND');
    expect(await outboxOf(wallet.id)).toEqual([]);
  });
});
