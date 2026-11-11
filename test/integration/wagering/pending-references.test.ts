/**
 * Transactions citing a reference not there yet, end to end against the real
 * PostgreSQL (`ARCHITECTURE.md` § Referências fora de ordem): the arrival
 * answers 202 `PENDING_REFERENCE` and writes `WagerTransactionPendingReference`,
 * and only the worker resolves it — when its reference arrives, with the
 * original correlation id; as `REFERENCE_NOT_FOUND` once the TTL is over; as
 * `REFERENCE_NOT_PROCESSED` at once when the reference failed. Short TTL and
 * intervals by configuration; waits are conditions with a timeout, never a
 * fixed sleep. Ends checking the ledger invariant of every wallet it touched.
 *
 * @packageDocumentation
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { SQL } from 'bun';
import { createApp } from '../../../src/app.ts';
import { loadConfig, type AppConfig } from '../../../src/config.ts';
import { expectLedgerConsistent } from '../ledger-invariant.ts';

type JsonObject = Record<string, unknown>;

interface TestWallet {
  id: string;
  playerId: string;
}

const TTL_MS = 1500;

const apps: INestApplication[] = [];
let config: AppConfig;
let baseUrl: string;
let sql: SQL;
const touchedWallets: string[] = [];

async function startApp(appConfig: AppConfig): Promise<INestApplication> {
  const app = await createApp(appConfig);
  await app.listen(0, '127.0.0.1');
  apps.push(app);
  return app;
}

beforeAll(async () => {
  const base = loadConfig();
  config = {
    ...base,
    pendingReferences: { ...base.pendingReferences, ttlMs: TTL_MS, retryBaseMs: 20, retryMaxMs: 100 },
  };
  baseUrl = await (await startApp(config)).getUrl();
  sql = new SQL(config.databaseUrl);
});

afterAll(async () => {
  await expectLedgerConsistent(sql, touchedWallets);
  await Promise.all(apps.map((app) => app.close()));
  await sql?.close();
});

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

function transactionOn(wallet: TestWallet, kind: string, overrides: JsonObject = {}): JsonObject {
  return {
    providerId: 'provider-a',
    externalTransactionId: Bun.randomUUIDv7(),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind,
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  };
}

/** A transaction citing `cited`, which may not exist yet. */
function citing(wallet: TestWallet, kind: string, cited: JsonObject): JsonObject {
  return transactionOn(wallet, kind, { referenceExternalTransactionId: cited.externalTransactionId, money: cited.money });
}

async function submit(
  body: JsonObject,
  correlationId = `corr-${body.externalTransactionId}`,
): Promise<{ status: number; body: JsonObject }> {
  const response = await fetch(`${baseUrl}/wagering/transactions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `key-${body.externalTransactionId}`,
      'x-correlation-id': correlationId,
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as JsonObject };
}

async function row(transactionId: unknown): Promise<JsonObject> {
  const [found] = await sql`
    select status, failure_code, attempts, next_attempt_at, created_at,
           balance_after_amount::text as balance_after, wallet_version_observed
      from wager_transactions where id = ${transactionId as string}
  `;
  return found;
}

async function eventsOf(transactionId: unknown): Promise<{ event_type: string; payload: JsonObject }[]> {
  return sql`
    select event_type, payload from outbox_messages
     where payload->>'causationId' = ${transactionId as string}
     order by event_type
  `;
}

describe('the arrival of a transaction citing a reference not there yet', () => {
  test.each(['REFUND', 'ROLLBACK', 'WIN'])(
    'a %s: 202 PENDING_REFERENCE, scheduled, and WagerTransactionPendingReference expiring at creation + TTL',
    async (kind) => {
      const wallet = await createWallet('100.00');
      const bet = transactionOn(wallet, 'BET');

      const { status, body } = await submit(citing(wallet, kind, bet), 'corr-arrival');

      expect(status).toBe(202);
      expect(body).toMatchObject({ status: 'PENDING_REFERENCE', idempotentReplay: false });
      const pending = await row(body.transactionId);
      expect(pending).toMatchObject({ status: 'PENDING_REFERENCE', attempts: 0, balance_after: null });
      expect(pending.next_attempt_at).toBeInstanceOf(Date);
      const events = await eventsOf(body.transactionId);
      expect(events.map((event) => event.event_type)).toEqual(['WagerTransactionPendingReference']);
      const [event] = events;
      expect(event!.payload).toMatchObject({
        eventType: 'WagerTransactionPendingReference',
        version: 1,
        aggregateId: body.transactionId,
        correlationId: 'corr-arrival',
        causationId: body.transactionId,
      });
      const createdAt = (pending.created_at as Date).getTime();
      expect(event!.payload.data).toMatchObject({
        transactionId: body.transactionId,
        walletId: wallet.id,
        kind,
        referenceExternalTransactionId: bet.externalTransactionId,
        expiresAt: new Date(createdAt + TTL_MS).toISOString(),
      });
    },
  );

  test('one citing another pending transaction waits too', async () => {
    const wallet = await createWallet('100.00');
    const bet = transactionOn(wallet, 'BET');
    const refund = citing(wallet, 'REFUND', bet);
    await submit(refund);

    const { status, body } = await submit(citing(wallet, 'ROLLBACK', refund));

    expect(status).toBe(202);
    expect(body).toMatchObject({ status: 'PENDING_REFERENCE' });
  });

  test('its replay writes no other event', async () => {
    const wallet = await createWallet('100.00');
    const refund = citing(wallet, 'REFUND', transactionOn(wallet, 'BET'));
    const first = await submit(refund);

    const replay = await submit(refund);

    expect(replay).toEqual({ status: 202, body: { ...first.body, idempotentReplay: true } });
    expect(await eventsOf(first.body.transactionId)).toHaveLength(1);
  });
});
