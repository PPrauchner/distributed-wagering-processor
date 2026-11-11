/**
 * The error path of `POST /wagering/transactions`, end to end against the real
 * PostgreSQL: transient failures answer 503 with `Retry-After` and record
 * nothing; a permanent error — provoked by the `FaultInjector` with a real
 * schema violation — records the transaction as `FAILED` and answers 500, and
 * so does its replay. Ends checking the ledger invariant of every wallet it
 * touched.
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

describe('a permanent error: FAILED, recorded by a second unit of work', () => {
  let faultyUrl: string;

  beforeAll(async () => {
    faultyUrl = await startApp({ ...config, faultPoints: [FaultPoint.InvariantViolationBeforeCommit] });
  });

  test('an invariant violated before the commit → 500 FAILED INFRA_INVARIANT_VIOLATION; balance, ledger untouched', async () => {
    const wallet = await createWallet('100.00');

    const response = await submit(faultyUrl, betOn(wallet));

    expect(response.status).toBe(500);
    const result = (await response.json()) as JsonObject;
    expect(result).toEqual({
      transactionId: expect.any(String),
      status: 'FAILED',
      failureCode: 'INFRA_INVARIANT_VIOLATION',
      idempotentReplay: false,
    });
    const rows = await sql`
      select id, status, failure_code, balance_after_amount, wallet_version_observed, processed_at
        from wager_transactions where wallet_id = ${wallet.id} and kind <> 'OPENING'
    `;
    expect(rows).toEqual([
      {
        id: result.transactionId,
        status: 'FAILED',
        failure_code: 'INFRA_INVARIANT_VIOLATION',
        balance_after_amount: null,
        wallet_version_observed: null,
        processed_at: null,
      },
    ]);
    const [walletRow] = await sql`
      select balance_amount::text as balance, version,
             (select count(*)::int from wallet_ledger_entries where wallet_id = ${wallet.id}) as entries
        from wallets where id = ${wallet.id}
    `;
    expect(walletRow).toEqual({ balance: '100.00', version: 1, entries: 1 });
  });

  test('the replay answers the same 500, with idempotentReplay; another payload is a conflict', async () => {
    const wallet = await createWallet('100.00');
    const body = betOn(wallet);
    const original = (await (await submit(faultyUrl, body)).json()) as JsonObject;

    const replay = await submit(baseUrl, body);
    const conflict = await submit(baseUrl, { ...body, money: { amount: '1.00', currency: 'BRL' } });

    expect(replay.status).toBe(500);
    expect(await replay.json()).toEqual({ ...original, idempotentReplay: true });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ failureCode: 'IDEMPOTENCY_CONFLICT' });
    expect(await transactionCount(wallet.id)).toBe(1);
  });

  describe('the FAILED write starts with the wallet lock (ADR 0002)', () => {
    /** Polls until a backend matching `condition` waits on a lock. */
    async function waitForLockWait(condition: (row: { pid: number; query: string }) => boolean): Promise<void> {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const rows = (await sql`
          select pid, query from pg_stat_activity where wait_event_type = 'Lock'
        `) as { pid: number; query: string }[];
        if (rows.some(condition)) return;
        await Bun.sleep(10);
      }
      throw new Error('no backend waited on the expected lock');
    }

    /**
     * Submits with the permanent fault and makes an outside session take the
     * wallet lock right after the first unit of work rolls back, so the FAILED
     * write meets a held wallet. The first unit of work is held, wallet locked,
     * on its insert by a table lock; the outside session queues on the wallet;
     * then the table lock goes.
     */
    async function failedWriteMeetingHeldWallet(wallet: TestWallet, holdMs: number): Promise<Response | undefined> {
      const tableHolder = await sql.reserve();
      const walletHolder = await sql.reserve();
      try {
        await tableHolder`begin`;
        await tableHolder`lock table wager_transactions in share mode`;
        const pending = submit(faultyUrl, betOn(wallet));
        await waitForLockWait(({ query }) => /insert into "wager_transactions"/i.test(query));

        await walletHolder`begin`;
        const [{ pid }] = (await walletHolder`select pg_backend_pid() as pid`) as [{ pid: number }];
        const walletLocked = (async () => walletHolder`select id from wallets where id = ${wallet.id} for update`)();
        await waitForLockWait((row) => row.pid === pid);
        await tableHolder`rollback`;
        await walletLocked;

        const response = await Promise.race([pending, Bun.sleep(holdMs).then(() => undefined)]);
        await walletHolder`rollback`;
        return response ?? (await pending);
      } finally {
        await tableHolder`rollback`.catch(() => undefined);
        await walletHolder`rollback`.catch(() => undefined);
        tableHolder.release();
        walletHolder.release();
      }
    }

    test('the wallet held beyond 2 s → 503 TRANSIENT_LOCK_TIMEOUT, nothing recorded', async () => {
      const wallet = await createWallet('100.00');

      const response = await failedWriteMeetingHeldWallet(wallet, 4_000);

      expect(response?.status).toBe(503);
      expect(await response?.json()).toEqual({ failureCode: 'TRANSIENT_LOCK_TIMEOUT', message: expect.any(String) });
      expect(await transactionCount(wallet.id)).toBe(0);
    }, 15_000);

    test('the wallet released before 2 s → a single FAILED for the key, no ledger entry', async () => {
      const wallet = await createWallet('100.00');

      const response = await failedWriteMeetingHeldWallet(wallet, 500);

      expect(response?.status).toBe(500);
      expect(await response?.json()).toMatchObject({ status: 'FAILED', failureCode: 'INFRA_INVARIANT_VIOLATION' });
      expect(await transactionCount(wallet.id)).toBe(1);
      const [{ entries }] = await sql`
        select count(*)::int as entries from wallet_ledger_entries where wallet_id = ${wallet.id}
      `;
      expect(entries).toBe(1);
    }, 15_000);
  });
});
