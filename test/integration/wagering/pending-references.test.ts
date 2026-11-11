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
import { FaultPoint } from '../../../src/shared/application/fault-injector.ts';
import { ResolvePendingReferences } from '../../../src/wagering/application/resolve-pending-references.ts';
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
let worker: ResolvePendingReferences;
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
  const app = await startApp(config);
  baseUrl = await app.getUrl();
  worker = app.get(ResolvePendingReferences);
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

/** Polls `probe` until it returns something, failing after the timeout — never a fixed sleep. */
async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('condition not met before the timeout');
    await Bun.sleep(20);
  }
}

/** Runs worker cycles until the transaction leaves `PENDING_REFERENCE`. */
async function resolvedBy(resolver: ResolvePendingReferences, transactionId: unknown): Promise<JsonObject> {
  return waitFor(async () => {
    await resolver.resolveDue();
    const current = await row(transactionId);
    return current.status === 'PENDING_REFERENCE' ? undefined : current;
  });
}

/** Waits, on the database clock, until the transaction's TTL is over. */
async function ttlOver(transactionId: unknown): Promise<void> {
  await waitFor(async () => {
    const [found] = await sql`
      select created_at + make_interval(secs => ${TTL_MS / 1000}) <= now() as over
        from wager_transactions where id = ${transactionId as string}
    `;
    return found.over ? true : undefined;
  });
}

async function walletRow(id: string): Promise<{ balance: string; version: number }> {
  const [found] = await sql`select balance_amount::text as balance, version from wallets where id = ${id}`;
  return found;
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

describe('the worker resolves a pending reference', () => {
  test('its reference arrives: resolved with no resend, the outcome events carry the original correlation id', async () => {
    const wallet = await createWallet('100.00');
    const bet = transactionOn(wallet, 'BET');
    const refund = citing(wallet, 'REFUND', bet);
    const pending = await submit(refund, 'corr-original');
    await submit(bet, 'corr-of-the-bet');

    const resolved = await resolvedBy(worker, pending.body.transactionId);

    expect(resolved).toMatchObject({ status: 'PROCESSED', balance_after: '100.00', wallet_version_observed: 3 });
    expect(await walletRow(wallet.id)).toEqual({ balance: '100.00', version: 3 });
    const events = await eventsOf(pending.body.transactionId);
    expect(events.map((event) => event.event_type)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    for (const event of events) {
      expect(event.payload).toMatchObject({ correlationId: 'corr-original', causationId: pending.body.transactionId });
    }
  });

  test('its replay answers the current state: 202 while pending, the terminal code once resolved', async () => {
    const wallet = await createWallet('100.00');
    const bet = transactionOn(wallet, 'BET');
    const win = transactionOn(wallet, 'WIN', { referenceExternalTransactionId: bet.externalTransactionId });
    const first = await submit(win);
    expect((await submit(win)).status).toBe(202);
    await submit(bet);
    await resolvedBy(worker, first.body.transactionId);

    const replay = await submit(win);

    expect(replay).toEqual({
      status: 200,
      body: {
        transactionId: first.body.transactionId,
        status: 'PROCESSED',
        balance: { amount: '100.00', currency: 'BRL' },
        idempotentReplay: true,
      },
    });
  });
});

describe('the worker turns a pending reference down', () => {
  test('within the TTL with no reference: counted and rescheduled; past it: REJECTED REFERENCE_NOT_FOUND, with its event', async () => {
    const wallet = await createWallet('100.00');
    const rollback = citing(wallet, 'ROLLBACK', transactionOn(wallet, 'BET'));
    const pending = await submit(rollback, 'corr-original');

    const retried = await waitFor(async () => {
      await worker.resolveDue();
      const current = await row(pending.body.transactionId);
      return (current.attempts as number) >= 1 ? current : undefined;
    });
    expect(retried).toMatchObject({ status: 'PENDING_REFERENCE' });

    const resolved = await resolvedBy(worker, pending.body.transactionId);

    expect(resolved).toMatchObject({
      status: 'REJECTED',
      failure_code: 'REFERENCE_NOT_FOUND',
      balance_after: '100.00',
      wallet_version_observed: 1,
    });
    const events = await eventsOf(pending.body.transactionId);
    expect(events.map((event) => event.event_type)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionRejected',
    ]);
    expect(events[1]!.payload).toMatchObject({
      correlationId: 'corr-original',
      data: { failureCode: 'REFERENCE_NOT_FOUND' },
    });
    expect(await submit(rollback)).toMatchObject({ status: 422, body: { failureCode: 'REFERENCE_NOT_FOUND' } });
  });

  test('its reference arrives REJECTED: REFERENCE_NOT_PROCESSED at once, without waiting for the TTL', async () => {
    const wallet = await createWallet('10.00');
    const bet = transactionOn(wallet, 'BET', { money: { amount: '50.00', currency: 'BRL' } });
    const refund = await submit(citing(wallet, 'REFUND', bet));
    expect((await submit(bet)).body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS' });

    const resolved = await resolvedBy(worker, refund.body.transactionId);

    expect(resolved).toMatchObject({ status: 'REJECTED', failure_code: 'REFERENCE_NOT_PROCESSED' });
    const [found] = await sql`
      select created_at + make_interval(secs => ${TTL_MS / 1000}) > now() as within
        from wager_transactions where id = ${refund.body.transactionId as string}
    `;
    expect(found.within).toBe(true);
  });

  test('its reference arrives FAILED: REFERENCE_NOT_PROCESSED', async () => {
    const faulty = await startApp({ ...config, faultPoints: [FaultPoint.InvariantViolationBeforeCommit] });
    const wallet = await createWallet('100.00');
    const bet = transactionOn(wallet, 'BET');
    const rollback = await submit(citing(wallet, 'ROLLBACK', bet));
    const failedBet = await fetch(`${await faulty.getUrl()}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `key-${bet.externalTransactionId}` },
      body: JSON.stringify(bet),
    });
    expect(await failedBet.json()).toMatchObject({ status: 'FAILED' });

    const resolved = await resolvedBy(worker, rollback.body.transactionId);

    expect(resolved).toMatchObject({ status: 'REJECTED', failure_code: 'REFERENCE_NOT_PROCESSED' });
  });
});

describe('the worker under failure', () => {
  test('a reference that arrived while the resolution failed transiently is resolved, even past the TTL', async () => {
    const faultyApp = await startApp({ ...config, faultPoints: [FaultPoint.TransientFailureInResolution] });
    const faulty = faultyApp.get(ResolvePendingReferences);
    const wallet = await createWallet('100.00');
    const bet = transactionOn(wallet, 'BET');
    const refund = await submit(citing(wallet, 'REFUND', bet));
    await submit(bet);
    // The reference is there, yet every attempt fails transiently: counted, still pending.
    await waitFor(async () => {
      await faulty.resolveDue();
      const current = await row(refund.body.transactionId);
      return (current.attempts as number) >= 2 ? current : undefined;
    });
    await ttlOver(refund.body.transactionId);
    expect(await row(refund.body.transactionId)).toMatchObject({ status: 'PENDING_REFERENCE' });

    const resolved = await resolvedBy(worker, refund.body.transactionId);

    expect(resolved).toMatchObject({ status: 'PROCESSED', balance_after: '100.00' });
  });

  test('a permanent error in the resolution records FAILED, with no event of the outcome', async () => {
    const faultyApp = await startApp({ ...config, faultPoints: [FaultPoint.InvariantViolationBeforeCommit] });
    const faulty = faultyApp.get(ResolvePendingReferences);
    const wallet = await createWallet('100.00');
    const bet = transactionOn(wallet, 'BET');
    const refund = citing(wallet, 'REFUND', bet);
    const pending = await submit(refund);
    await submit(bet);

    const resolved = await resolvedBy(faulty, pending.body.transactionId);

    expect(resolved).toMatchObject({ status: 'FAILED', failure_code: 'INFRA_INVARIANT_VIOLATION', balance_after: null });
    expect(await walletRow(wallet.id)).toEqual({ balance: '75.00', version: 2 });
    expect((await eventsOf(pending.body.transactionId)).map((event) => event.event_type)).toEqual([
      'WagerTransactionPendingReference',
    ]);
    expect((await submit(refund)).status).toBe(500);
  });

  test('two workers over the same pending references: each resolved once', async () => {
    const other = (await startApp(config)).get(ResolvePendingReferences);
    const wallet = await createWallet('100.00');
    const five = { amount: '5.00', currency: 'BRL' };
    const bets = Array.from({ length: 6 }, () => transactionOn(wallet, 'BET', { money: five }));
    const refunds: { status: number; body: JsonObject }[] = [];
    for (const bet of bets) refunds.push(await submit(citing(wallet, 'REFUND', bet)));
    for (const bet of bets) await submit(bet);

    await waitFor(async () => {
      await Promise.all([worker.resolveDue(), other.resolveDue(), worker.resolveDue(), other.resolveDue()]);
      const current = await Promise.all(refunds.map((refund) => row(refund.body.transactionId)));
      return current.every((found) => found.status === 'PROCESSED') ? true : undefined;
    });

    expect(await walletRow(wallet.id)).toEqual({ balance: '100.00', version: 13 });
    for (const refund of refunds) {
      const [entries] = await sql`
        select count(*)::int as n from wallet_ledger_entries where transaction_id = ${refund.body.transactionId as string}
      `;
      expect(entries.n).toBe(1);
      const events = (await eventsOf(refund.body.transactionId)).map((event) => event.event_type);
      expect(events.filter((type) => type === 'WagerTransactionProcessed')).toHaveLength(1);
    }
  });
});
