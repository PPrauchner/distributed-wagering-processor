/**
 * `POST /wagering/transactions` end to end for the `REFUND` and the `ROLLBACK`
 * citing a reference already there: the app runs in process against the real
 * PostgreSQL. Checks the response, the wallet, the ledger and the outbox of each
 * outcome, that a reference is undone once by any kind — in parallel too — and
 * ends checking the ledger invariant of every wallet it touched.
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
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  };
}

/** A transaction undoing — or trying to undo — the cited one. */
function undoing(wallet: TestWallet, kind: string, cited: JsonObject, overrides: JsonObject = {}): JsonObject {
  return transactionOn(wallet, kind, {
    referenceExternalTransactionId: cited.externalTransactionId,
    money: cited.money,
    ...overrides,
  });
}

async function submit(body: JsonObject): Promise<{ status: number; body: JsonObject }> {
  const response = await fetch(`${baseUrl}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': `key-${body.externalTransactionId}` },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as JsonObject };
}

/** Submits a transaction and asserts it was processed. */
async function processed(body: JsonObject): Promise<JsonObject> {
  const { status } = await submit(body);
  expect(status).toBe(200);
  return body;
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

async function idOf(body: JsonObject): Promise<string> {
  const [found] = await sql`
    select id from wager_transactions where external_transaction_id = ${body.externalTransactionId as string}
  `;
  return found.id;
}

async function row(transactionId: unknown): Promise<JsonObject> {
  const [found] = await sql`
    select status, reference_transaction_id, balance_after_amount::text as balance_after,
           wallet_version_observed, failure_code, failure_message
      from wager_transactions where id = ${transactionId as string}
  `;
  return found;
}

describe('a REFUND of a processed BET', () => {
  test('200 PROCESSED: credits the same amount, one CREDIT entry, version +1, Processed and BalanceChanged', async () => {
    const wallet = await createWallet('100.00');
    const bet = await processed(transactionOn(wallet, 'BET'));

    const { status, body } = await submit(undoing(wallet, 'REFUND', bet));

    expect(status).toBe(200);
    expect(body).toEqual({
      transactionId: expect.any(String),
      status: 'PROCESSED',
      balance: { amount: '100.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    expect(await walletRow(wallet.id)).toEqual({ balance: '100.00', version: 3 });
    expect(await entriesOf(body.transactionId)).toEqual([{ direction: 'CREDIT', amount: '25.00', wallet_version: 3 }]);
    expect((await row(body.transactionId)).reference_transaction_id).toBe(await idOf(bet));
    expect(await eventsOf(body.transactionId)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
  });

  test('the replay answers the original outcome', async () => {
    const wallet = await createWallet('100.00');
    const bet = await processed(transactionOn(wallet, 'BET'));
    const refund = undoing(wallet, 'REFUND', bet);

    const original = await submit(refund);
    const replay = await submit(refund);

    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...original.body, idempotentReplay: true });
    expect(await walletRow(wallet.id)).toEqual({ balance: '100.00', version: 3 });
  });
});

describe('a ROLLBACK applies the inverse of its reference', () => {
  test('of a BET: credits', async () => {
    const wallet = await createWallet('100.00');
    const bet = await processed(transactionOn(wallet, 'BET'));

    const { status, body } = await submit(undoing(wallet, 'ROLLBACK', bet));

    expect(status).toBe(200);
    expect(body).toMatchObject({ status: 'PROCESSED', balance: { amount: '100.00', currency: 'BRL' } });
    expect(await entriesOf(body.transactionId)).toEqual([{ direction: 'CREDIT', amount: '25.00', wallet_version: 3 }]);
    expect(await eventsOf(body.transactionId)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
  });

  test('of a WIN: debits', async () => {
    const wallet = await createWallet('100.00');
    const win = await processed(transactionOn(wallet, 'WIN'));

    const { status, body } = await submit(undoing(wallet, 'ROLLBACK', win));

    expect(status).toBe(200);
    expect(body).toMatchObject({ status: 'PROCESSED', balance: { amount: '100.00', currency: 'BRL' } });
    expect(await entriesOf(body.transactionId)).toEqual([{ direction: 'DEBIT', amount: '25.00', wallet_version: 3 }]);
    expect((await row(body.transactionId)).reference_transaction_id).toBe(await idOf(win));
    expect(await eventsOf(body.transactionId)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
  });

  test('of a REFUND: debits; the bet counts again but cannot be undone anymore', async () => {
    const wallet = await createWallet('100.00');
    const bet = await processed(transactionOn(wallet, 'BET'));
    const refund = await processed(undoing(wallet, 'REFUND', bet));

    const { status, body } = await submit(undoing(wallet, 'ROLLBACK', refund));
    const refundAgain = await submit(undoing(wallet, 'REFUND', bet));

    expect(status).toBe(200);
    expect(body).toMatchObject({ status: 'PROCESSED', balance: { amount: '75.00', currency: 'BRL' } });
    expect(await entriesOf(body.transactionId)).toEqual([{ direction: 'DEBIT', amount: '25.00', wallet_version: 4 }]);
    expect(await eventsOf(body.transactionId)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    expect(refundAgain.status).toBe(422);
    expect(refundAgain.body).toMatchObject({ failureCode: 'REFERENCE_ALREADY_REVERSED' });
  });
});

describe('a reference is undone once, by any kind', () => {
  test.each([
    ['REFUND', 'REFUND'],
    ['REFUND', 'ROLLBACK'],
    ['ROLLBACK', 'REFUND'],
    ['ROLLBACK', 'ROLLBACK'],
  ])('a %s, then a %s of the same BET: 422 REFERENCE_ALREADY_REVERSED, only Rejected', async (first, second) => {
    const wallet = await createWallet('100.00');
    const bet = await processed(transactionOn(wallet, 'BET'));
    await processed(undoing(wallet, first, bet));
    const before = await walletRow(wallet.id);

    const { status, body } = await submit(undoing(wallet, second, bet));

    expect(status).toBe(422);
    expect(body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'REFERENCE_ALREADY_REVERSED',
      balance: { amount: before.balance, currency: 'BRL' },
    });
    expect(await walletRow(wallet.id)).toEqual(before);
    expect(await entriesOf(body.transactionId)).toEqual([]);
    expect(await eventsOf(body.transactionId)).toEqual(['WagerTransactionRejected']);
  });

  test.each([
    ['REFUND', 'REFUND'],
    ['REFUND', 'ROLLBACK'],
    ['ROLLBACK', 'ROLLBACK'],
  ])('a %s and a %s of the same BET in parallel: exactly one PROCESSED, one entry', async (first, second) => {
    const wallet = await createWallet('100.00');
    const bet = await processed(transactionOn(wallet, 'BET'));

    const outcomes = await Promise.all([submit(undoing(wallet, first, bet)), submit(undoing(wallet, second, bet))]);

    expect(outcomes.map(({ status }) => status).sort()).toEqual([200, 422]);
    const rejected = outcomes.find(({ status }) => status === 422)!;
    expect(rejected.body).toMatchObject({ failureCode: 'REFERENCE_ALREADY_REVERSED' });
    const [{ count }] = await sql`
      select count(*)::int as count from wager_transactions
       where reference_transaction_id = ${await idOf(bet)} and status = 'PROCESSED'
    `;
    expect(count).toBe(1);
    expect(await walletRow(wallet.id)).toEqual({ balance: '100.00', version: 3 });
  });
});

describe('a ROLLBACK that would leave the balance negative', () => {
  test('of a WIN: 422 REVERSAL_INSUFFICIENT_FUNDS, no entry, Rejected with the balance observed', async () => {
    const wallet = await createWallet('0.00');
    const win = await processed(transactionOn(wallet, 'WIN', { money: { amount: '50.00', currency: 'BRL' } }));
    await processed(transactionOn(wallet, 'BET', { money: { amount: '40.00', currency: 'BRL' } }));

    const { status, body } = await submit(undoing(wallet, 'ROLLBACK', win));

    expect(status).toBe(422);
    expect(body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'REVERSAL_INSUFFICIENT_FUNDS',
      balance: { amount: '10.00', currency: 'BRL' },
    });
    expect(await row(body.transactionId)).toMatchObject({ balance_after: '10.00', wallet_version_observed: 3 });
    expect(await walletRow(wallet.id)).toEqual({ balance: '10.00', version: 3 });
    expect(await entriesOf(body.transactionId)).toEqual([]);
    expect(await eventsOf(body.transactionId)).toEqual(['WagerTransactionRejected']);
  });

  test('of a REFUND: 422 REVERSAL_INSUFFICIENT_FUNDS', async () => {
    const wallet = await createWallet('25.00');
    const bet = await processed(transactionOn(wallet, 'BET'));
    const refund = await processed(undoing(wallet, 'REFUND', bet));
    await processed(transactionOn(wallet, 'BET'));

    const { status, body } = await submit(undoing(wallet, 'ROLLBACK', refund));

    expect(status).toBe(422);
    expect(body).toMatchObject({ failureCode: 'REVERSAL_INSUFFICIENT_FUNDS', balance: { amount: '0.00', currency: 'BRL' } });
    expect(await entriesOf(body.transactionId)).toEqual([]);
  });
});

describe('the reference rules', () => {
  test.each(['REFUND', 'ROLLBACK'])('a %s of another amount: 422 REFERENCE_AMOUNT_MISMATCH', async (kind) => {
    const wallet = await createWallet('100.00');
    const bet = await processed(transactionOn(wallet, 'BET'));

    const { status, body } = await submit(undoing(wallet, kind, bet, { money: { amount: '24.99', currency: 'BRL' } }));

    expect(status).toBe(422);
    expect(body).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_AMOUNT_MISMATCH' });
    expect(await eventsOf(body.transactionId)).toEqual(['WagerTransactionRejected']);
  });

  // The cited transaction of each kind, processed on the wallet.
  const citedOf: Record<string, (wallet: TestWallet) => Promise<JsonObject>> = {
    WIN: (wallet) => processed(transactionOn(wallet, 'WIN')),
    LOSS: (wallet) => processed(transactionOn(wallet, 'LOSS')),
    REFUND: async (wallet) => processed(undoing(wallet, 'REFUND', await processed(transactionOn(wallet, 'BET')))),
    ROLLBACK: async (wallet) => processed(undoing(wallet, 'ROLLBACK', await processed(transactionOn(wallet, 'BET')))),
  };

  test.each([
    ['REFUND', 'WIN'],
    ['REFUND', 'LOSS'],
    ['REFUND', 'REFUND'],
    ['REFUND', 'ROLLBACK'],
    ['ROLLBACK', 'LOSS'],
    ['ROLLBACK', 'ROLLBACK'],
  ])('a %s of a %s: 422 REFERENCE_KIND_NOT_ALLOWED', async (kind, citedKind) => {
    const wallet = await createWallet('100.00');
    const cited = await citedOf[citedKind]!(wallet);

    const { status, body } = await submit(undoing(wallet, kind, cited));

    expect(status).toBe(422);
    expect(body).toMatchObject({ failureCode: 'REFERENCE_KIND_NOT_ALLOWED' });
  });

  // A processed bet has its wallet's currency: the same wallet means the same
  // currency, so a currency-only mismatch is covered by the unit tests.
  test.each<[string, (wallet: TestWallet) => Promise<TestWallet>, JsonObject]>([
    ['playerId', () => createWallet('100.00'), {}],
    ['walletId', (wallet) => createWallet('100.00', 'EUR', wallet.playerId), { money: { amount: '25.00', currency: 'EUR' } }],
    ['roundId', async (wallet) => wallet, { roundId: 'another-round' }],
  ])('a BET with another %s: 422 REFERENCE_MISMATCH naming the field', async (field, betWalletOf, betOverrides) => {
    const wallet = await createWallet('100.00');
    const bet = await processed(transactionOn(await betWalletOf(wallet), 'BET', betOverrides));

    const { status, body } = await submit(undoing(wallet, 'REFUND', bet, { money: { amount: '25.00', currency: 'BRL' } }));

    expect(status).toBe(422);
    expect(body).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_MISMATCH' });
    expect(body.message).toContain(field);
    expect(await entriesOf(body.transactionId)).toEqual([]);
  });

  test('citing a REJECTED BET: 422 REFERENCE_NOT_PROCESSED', async () => {
    const wallet = await createWallet('10.00');
    const bet = transactionOn(wallet, 'BET');
    expect((await submit(bet)).status).toBe(422);

    const { status, body } = await submit(undoing(wallet, 'REFUND', bet));

    expect(status).toBe(422);
    expect(body).toMatchObject({ failureCode: 'REFERENCE_NOT_PROCESSED' });
  });

  test('another amount of a reference already undone: the amount comes first', async () => {
    const wallet = await createWallet('100.00');
    const bet = await processed(transactionOn(wallet, 'BET'));
    await processed(undoing(wallet, 'REFUND', bet));

    const { body } = await submit(undoing(wallet, 'ROLLBACK', bet, { money: { amount: '1.00', currency: 'BRL' } }));

    expect(body).toMatchObject({ failureCode: 'REFERENCE_AMOUNT_MISMATCH' });
  });

  test.each(['REFUND', 'ROLLBACK'])(
    'a %s citing a reference not there: 202 PENDING_REFERENCE, nothing moved, only the pending event',
    async (kind) => {
      const wallet = await createWallet('100.00');

      const { status, body } = await submit(
        transactionOn(wallet, kind, { referenceExternalTransactionId: Bun.randomUUIDv7() }),
      );

      expect(status).toBe(202);
      expect(body).toEqual({ transactionId: expect.any(String), status: 'PENDING_REFERENCE', idempotentReplay: false });
      expect(await row(body.transactionId)).toMatchObject({ status: 'PENDING_REFERENCE', balance_after: null });
      expect(await walletRow(wallet.id)).toEqual({ balance: '100.00', version: 1 });
      expect(await entriesOf(body.transactionId)).toEqual([]);
      expect(await eventsOf(body.transactionId)).toEqual(['WagerTransactionPendingReference']);
    },
  );

  test.each(['REFUND', 'ROLLBACK'])('a %s without a reference → 400 INVALID_PAYLOAD', async (kind) => {
    const wallet = await createWallet('100.00');

    const { status, body } = await submit(transactionOn(wallet, kind));

    expect(status).toBe(400);
    expect(body).toMatchObject({ failureCode: 'INVALID_PAYLOAD' });
  });
});
