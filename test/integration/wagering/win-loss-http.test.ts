/**
 * `POST /wagering/transactions` end to end for the `WIN` and the `LOSS`: the app
 * runs in process against the real PostgreSQL. Checks the response, the wallet,
 * the ledger and the outbox of each outcome, and ends checking the ledger
 * invariant of every wallet it touched.
 *
 * @packageDocumentation
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { SQL } from 'bun';
import { createApp } from '../../../src/app.ts';
import { loadConfig } from '../../../src/config.ts';
import { expectLedgerConsistent } from '../ledger-invariant.ts';

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

type JsonObject = Record<string, unknown>;

interface TestWallet {
  id: string;
  playerId: string;
}

async function createWallet(amount: string, currency = 'BRL', playerId = Bun.randomUUIDv7()): Promise<TestWallet> {
  const response = await fetch(`${baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, initialBalance: { amount, currency } }),
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
    money: { amount: kind === 'LOSS' ? '0.00' : '25.00', currency: 'BRL' },
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

/** Submits a bet and asserts it was processed. */
async function placeBet(wallet: TestWallet, overrides: JsonObject = {}): Promise<JsonObject> {
  const bet = transactionOn(wallet, 'BET', overrides);
  const { status } = await submit(bet);
  expect(status).toBe(200);
  return bet;
}

async function walletRow(id: string): Promise<{ balance: string; version: number }> {
  const [row] = await sql`select balance_amount::text as balance, version from wallets where id = ${id}`;
  return row;
}

async function entriesOf(transactionId: unknown): Promise<JsonObject[]> {
  return sql`
    select direction, amount::text as amount, wallet_version
      from wallet_ledger_entries where transaction_id = ${transactionId as string}
  `;
}

async function eventsOf(transactionId: unknown): Promise<string[]> {
  const rows: { event_type: string }[] = await sql`
    select event_type from outbox_messages
     where aggregate_id = ${transactionId as string} or payload->'data'->>'transactionId' = ${transactionId as string}
     order by event_type
  `;
  return rows.map((row) => row.event_type);
}

async function row(transactionId: unknown): Promise<JsonObject> {
  const [found] = await sql`
    select status, reference_transaction_id, balance_after_amount::text as balance_after,
           wallet_version_observed, failure_code, failure_message
      from wager_transactions where id = ${transactionId as string}
  `;
  return found;
}

describe('a WIN without a reference', () => {
  test('200 PROCESSED: credit, one CREDIT entry, version +1, Processed and BalanceChanged', async () => {
    const wallet = await createWallet('100.00');

    const { status, body } = await submit(transactionOn(wallet, 'WIN', { money: { amount: '40.00', currency: 'BRL' } }));

    expect(status).toBe(200);
    expect(body).toEqual({
      transactionId: expect.any(String),
      status: 'PROCESSED',
      balance: { amount: '140.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    expect(await walletRow(wallet.id)).toEqual({ balance: '140.00', version: 2 });
    expect(await entriesOf(body.transactionId)).toEqual([{ direction: 'CREDIT', amount: '40.00', wallet_version: 2 }]);
    expect(await eventsOf(body.transactionId)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
  });

  test("on another player's wallet: 422 WALLET_PLAYER_MISMATCH, only Rejected", async () => {
    const wallet = await createWallet('100.00');

    const { status, body } = await submit(transactionOn(wallet, 'WIN', { playerId: Bun.randomUUIDv7() }));

    expect(status).toBe(422);
    expect(body).toMatchObject({ status: 'REJECTED', failureCode: 'WALLET_PLAYER_MISMATCH' });
    expect(await eventsOf(body.transactionId)).toEqual(['WagerTransactionRejected']);
  });

  test('a zero WIN → 400 INVALID_PAYLOAD', async () => {
    const wallet = await createWallet('100.00');

    const { status, body } = await submit(transactionOn(wallet, 'WIN', { money: { amount: '0.00', currency: 'BRL' } }));

    expect(status).toBe(400);
    expect(body).toMatchObject({ failureCode: 'INVALID_PAYLOAD' });
  });
});

describe('a WIN citing the bet of its round', () => {
  test('a coherent processed BET: PROCESSED with another amount, the reference recorded; a second WIN too', async () => {
    const wallet = await createWallet('100.00');
    const bet = await placeBet(wallet);
    const cite = { referenceExternalTransactionId: bet.externalTransactionId };

    const first = await submit(transactionOn(wallet, 'WIN', { ...cite, money: { amount: '60.00', currency: 'BRL' } }));
    const second = await submit(transactionOn(wallet, 'WIN', cite));

    expect([first.status, second.status]).toEqual([200, 200]);
    expect(first.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '135.00', currency: 'BRL' } });
    expect(second.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '160.00', currency: 'BRL' } });
    const [betRow] = await sql`select id from wager_transactions where external_transaction_id = ${bet.externalTransactionId as string}`;
    expect((await row(first.body.transactionId)).reference_transaction_id).toBe(betRow.id);
    expect((await row(second.body.transactionId)).reference_transaction_id).toBe(betRow.id);
    expect(await walletRow(wallet.id)).toEqual({ balance: '160.00', version: 4 });
  });

  // A processed bet has its wallet's currency: the same wallet means the same
  // currency, so a currency-only mismatch is covered by the unit tests.
  test.each<[string, (wallet: TestWallet) => Promise<TestWallet>, JsonObject]>([
    ['playerId', () => createWallet('100.00'), {}],
    ['walletId', (wallet) => createWallet('100.00', 'EUR', wallet.playerId), { money: { amount: '5.00', currency: 'EUR' } }],
    ['roundId', async (wallet) => wallet, { roundId: 'another-round' }],
  ])('a BET with another %s: 422 REFERENCE_MISMATCH naming the field', async (field, betWalletOf, betOverrides) => {
    const wallet = await createWallet('100.00');
    const bet = await placeBet(await betWalletOf(wallet), betOverrides);
    const before = await walletRow(wallet.id);

    const { status, body } = await submit(
      transactionOn(wallet, 'WIN', { referenceExternalTransactionId: bet.externalTransactionId }),
    );

    expect(status).toBe(422);
    expect(body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'REFERENCE_MISMATCH',
      balance: { amount: before.balance, currency: 'BRL' },
    });
    expect(body.message).toContain(field);
    expect(await walletRow(wallet.id)).toEqual(before);
    expect(await entriesOf(body.transactionId)).toEqual([]);
    expect(await eventsOf(body.transactionId)).toEqual(['WagerTransactionRejected']);
  });

  test.each(['WIN', 'LOSS'])('citing a %s: 422 REFERENCE_KIND_NOT_ALLOWED', async (kind) => {
    const wallet = await createWallet('100.00');
    const cited = transactionOn(wallet, kind);
    expect((await submit(cited)).status).toBe(200);

    const { status, body } = await submit(
      transactionOn(wallet, 'WIN', { referenceExternalTransactionId: cited.externalTransactionId }),
    );

    expect(status).toBe(422);
    expect(body).toMatchObject({ failureCode: 'REFERENCE_KIND_NOT_ALLOWED' });
  });

  test('citing a REJECTED BET: 422 REFERENCE_NOT_PROCESSED', async () => {
    const wallet = await createWallet('10.00');
    const bet = transactionOn(wallet, 'BET', { money: { amount: '50.00', currency: 'BRL' } });
    expect((await submit(bet)).status).toBe(422);

    const { status, body } = await submit(
      transactionOn(wallet, 'WIN', { referenceExternalTransactionId: bet.externalTransactionId }),
    );

    expect(status).toBe(422);
    expect(body).toMatchObject({ failureCode: 'REFERENCE_NOT_PROCESSED' });
  });

  test('a reference not there yet: 202 PENDING_REFERENCE, nothing moved, only the pending event; the replay is 202 too', async () => {
    const wallet = await createWallet('100.00');
    const win = transactionOn(wallet, 'WIN', { referenceExternalTransactionId: Bun.randomUUIDv7() });

    const first = await submit(win);
    const replay = await submit(win);

    expect(first.status).toBe(202);
    expect(first.body).toEqual({ transactionId: expect.any(String), status: 'PENDING_REFERENCE', idempotentReplay: false });
    expect(replay.status).toBe(202);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    expect(await row(first.body.transactionId)).toMatchObject({ status: 'PENDING_REFERENCE', balance_after: null });
    expect(await walletRow(wallet.id)).toEqual({ balance: '100.00', version: 1 });
    expect(await entriesOf(first.body.transactionId)).toEqual([]);
    expect(await eventsOf(first.body.transactionId)).toEqual(['WagerTransactionPendingReference']);
  });

  test('a rejection replays with its message', async () => {
    const wallet = await createWallet('100.00');
    const bet = await placeBet(wallet, { roundId: 'another-round' });
    const win = transactionOn(wallet, 'WIN', { referenceExternalTransactionId: bet.externalTransactionId });

    const original = await submit(win);
    const replay = await submit(win);

    expect(replay.status).toBe(422);
    expect(replay.body).toEqual({ ...original.body, idempotentReplay: true });
    expect(replay.body.message).toContain('roundId');
  });
});

describe('a LOSS', () => {
  test.each(['0.00', '25.00'])(
    'of %s: 200 PROCESSED, balance and version untouched, no entry, only Processed',
    async (amount) => {
      const wallet = await createWallet('100.00');

      const { status, body } = await submit(transactionOn(wallet, 'LOSS', { money: { amount, currency: 'BRL' } }));

      expect(status).toBe(200);
      expect(body).toEqual({
        transactionId: expect.any(String),
        status: 'PROCESSED',
        balance: { amount: '100.00', currency: 'BRL' },
        idempotentReplay: false,
      });
      expect(await walletRow(wallet.id)).toEqual({ balance: '100.00', version: 1 });
      expect(await entriesOf(body.transactionId)).toEqual([]);
      expect(await row(body.transactionId)).toMatchObject({ balance_after: '100.00', wallet_version_observed: 1 });
      expect(await eventsOf(body.transactionId)).toEqual(['WagerTransactionProcessed']);
    },
  );

  test('the replay answers the balance it observed, even after the balance moved', async () => {
    const wallet = await createWallet('100.00');
    const loss = transactionOn(wallet, 'LOSS');
    const original = await submit(loss);
    await placeBet(wallet);

    const replay = await submit(loss);

    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...original.body, idempotentReplay: true });
    expect(replay.body.balance).toEqual({ amount: '100.00', currency: 'BRL' });
  });

  test('in another currency: 422 CURRENCY_MISMATCH', async () => {
    const wallet = await createWallet('100.00');

    const { status, body } = await submit(transactionOn(wallet, 'LOSS', { money: { amount: '0.00', currency: 'USD' } }));

    expect(status).toBe(422);
    expect(body).toMatchObject({ failureCode: 'CURRENCY_MISMATCH' });
  });

  test('with a reference → 400 INVALID_PAYLOAD', async () => {
    const wallet = await createWallet('100.00');

    const { status, body } = await submit(transactionOn(wallet, 'LOSS', { referenceExternalTransactionId: 'bet-1' }));

    expect(status).toBe(400);
    expect(body).toMatchObject({ failureCode: 'INVALID_PAYLOAD' });
  });

  test('a WIN and a LOSS in the same round are both accepted', async () => {
    const wallet = await createWallet('100.00');

    const win = await submit(transactionOn(wallet, 'WIN'));
    const loss = await submit(transactionOn(wallet, 'LOSS'));

    expect([win.status, loss.status]).toEqual([200, 200]);
  });
});
