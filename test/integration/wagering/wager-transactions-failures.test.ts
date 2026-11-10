/**
 * The error path of `POST /wagering/transactions`, end to end against the real
 * PostgreSQL: transient failures answer 503 with `Retry-After` and record
 * nothing. Ends checking the ledger invariant of every wallet it touched.
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

function betOn(wallet: TestWallet): JsonObject {
  return {
    providerId: 'provider-a',
    externalTransactionId: Bun.randomUUIDv7(),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  };
}

function submit(url: string, body: JsonObject): Promise<Response> {
  return fetch(`${url}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': `key-${body.externalTransactionId}` },
    body: JSON.stringify(body),
  });
}

async function transactionCount(walletId: string): Promise<number> {
  const [row] = await sql`
    select count(*)::int as n from wager_transactions where wallet_id = ${walletId} and kind <> 'OPENING'
  `;
  return row.n;
}

describe('transient failures: 503 with Retry-After, nothing recorded', () => {
  test('the wallet locked beyond 2 s → TRANSIENT_LOCK_TIMEOUT; once released, the same key is processed', async () => {
    const wallet = await createWallet('100.00');
    const body = betOn(wallet);
    const holder = await sql.reserve();
    let response: Response;
    try {
      await holder`begin`;
      await holder`select id from wallets where id = ${wallet.id} for update`;

      response = await submit(baseUrl, body);
    } finally {
      await holder`rollback`;
      holder.release();
    }

    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('1');
    expect(await response.json()).toEqual({ failureCode: 'TRANSIENT_LOCK_TIMEOUT', message: expect.any(String) });
    expect(await transactionCount(wallet.id)).toBe(0);

    const resent = await submit(baseUrl, body);

    expect(resent.status).toBe(200);
    expect(await resent.json()).toMatchObject({ status: 'PROCESSED', idempotentReplay: false });
  }, 10_000);

  test('the database unreachable → TRANSIENT_UNAVAILABLE', async () => {
    const unreachable = new URL(config.databaseUrl);
    unreachable.port = '1';
    const offlineUrl = await startApp({ ...config, databaseUrl: unreachable.toString(), retryAfterSeconds: 3 });

    const response = await submit(offlineUrl, betOn({ id: Bun.randomUUIDv7(), playerId: Bun.randomUUIDv7() }));

    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('3');
    expect(await response.json()).toEqual({ failureCode: 'TRANSIENT_UNAVAILABLE', message: expect.any(String) });
  });
});
