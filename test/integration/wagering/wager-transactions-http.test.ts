/**
 * `POST /wagering/transactions` end to end for a `BET`: the app runs in process
 * against the real PostgreSQL and is driven by real, and really parallel, HTTP
 * requests. Ends checking the ledger invariant of every wallet it touched.
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

async function createWallet(amount: string, currency = 'BRL'): Promise<TestWallet> {
  const playerId = Bun.randomUUIDv7();
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

function betOn(wallet: TestWallet, overrides: JsonObject = {}): JsonObject {
  return {
    providerId: 'provider-a',
    externalTransactionId: Bun.randomUUIDv7(),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  };
}

const keyOf = (body: JsonObject): string => `${body.providerId}:${body.externalTransactionId}`;

/** Submits with `Idempotency-Key` = provider:externalId unless headers say otherwise. */
function submit(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const defaultKey: Record<string, string> =
    typeof body === 'object' && body !== null && 'externalTransactionId' in body
      ? { 'idempotency-key': keyOf(body as JsonObject) }
      : {};
  return fetch(`${baseUrl}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...defaultKey, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function readJson(response: Response): Promise<JsonObject> {
  return (await response.json()) as JsonObject;
}

async function walletRow(id: string): Promise<{ balance: string; version: number }> {
  const [row] = await sql`select balance_amount::text as balance, version from wallets where id = ${id}`;
  return row;
}

async function debits(walletId: string): Promise<number> {
  const [row] = await sql`
    select count(*)::int as n from wallet_ledger_entries where wallet_id = ${walletId} and direction = 'DEBIT'
  `;
  return row.n;
}

async function transactionsOf(walletId: string): Promise<JsonObject[]> {
  return sql`
    select id, kind, status, failure_code, balance_after_amount::text as balance_after,
           balance_after_currency, wallet_version_observed, correlation_id, idempotency_key
      from wager_transactions where wallet_id = ${walletId} and kind <> 'OPENING'
  `;
}

describe('a BET', () => {
  test('with funds: 200 PROCESSED with the resulting balance; debit, version +1 and one DEBIT entry', async () => {
    const wallet = await createWallet('100.00');
    const body = betOn(wallet);

    const response = await submit(body);

    expect(response.status).toBe(200);
    const result = await readJson(response);
    expect(result).toEqual({
      transactionId: expect.any(String),
      status: 'PROCESSED',
      balance: { amount: '75.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    expect(await walletRow(wallet.id)).toEqual({ balance: '75.00', version: 2 });
    expect(await debits(wallet.id)).toBe(1);
    const [entry] = await sql`
      select transaction_id, amount::text as amount, wallet_version
        from wallet_ledger_entries where wallet_id = ${wallet.id} and direction = 'DEBIT'
    `;
    expect(entry).toEqual({ transaction_id: result.transactionId, amount: '25.00', wallet_version: 2 });
    const [transaction] = await transactionsOf(wallet.id);
    expect(transaction).toMatchObject({
      id: result.transactionId,
      kind: 'BET',
      status: 'PROCESSED',
      failure_code: null,
      balance_after: '75.00',
      wallet_version_observed: 2,
    });
  });

  test('without funds: 422 REJECTED INSUFFICIENT_FUNDS; balance, version and ledger intact; balance observed', async () => {
    const wallet = await createWallet('10.00');

    const response = await submit(betOn(wallet));

    expect(response.status).toBe(422);
    expect(await readJson(response)).toEqual({
      transactionId: expect.any(String),
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: { amount: '10.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    expect(await walletRow(wallet.id)).toEqual({ balance: '10.00', version: 1 });
    expect(await debits(wallet.id)).toBe(0);
    const [transaction] = await transactionsOf(wallet.id);
    expect(transaction).toMatchObject({
      status: 'REJECTED',
      failure_code: 'INSUFFICIENT_FUNDS',
      balance_after: '10.00',
      wallet_version_observed: 1,
    });
  });

  test('in another currency: 422 CURRENCY_MISMATCH, observing the balance in the wallet currency', async () => {
    const wallet = await createWallet('100.00');

    const response = await submit(betOn(wallet, { money: { amount: '5.00', currency: 'USD' } }));

    expect(response.status).toBe(422);
    expect(await readJson(response)).toMatchObject({
      status: 'REJECTED',
      failureCode: 'CURRENCY_MISMATCH',
      balance: { amount: '100.00', currency: 'BRL' },
    });
    const [transaction] = await transactionsOf(wallet.id);
    expect(transaction).toMatchObject({ balance_after: '100.00', balance_after_currency: 'BRL' });
  });

  test("on another player's wallet: 422 WALLET_PLAYER_MISMATCH", async () => {
    const wallet = await createWallet('100.00');

    const response = await submit(betOn(wallet, { playerId: Bun.randomUUIDv7() }));

    expect(response.status).toBe(422);
    expect(await readJson(response)).toMatchObject({ status: 'REJECTED', failureCode: 'WALLET_PLAYER_MISMATCH' });
    expect(await walletRow(wallet.id)).toEqual({ balance: '100.00', version: 1 });
  });

  test('on a wallet that does not exist: 422 WALLET_NOT_FOUND and no transaction', async () => {
    const walletId = Bun.randomUUIDv7();

    const response = await submit(betOn({ id: walletId, playerId: Bun.randomUUIDv7() }));

    expect(response.status).toBe(422);
    expect(await readJson(response)).toEqual({ failureCode: 'WALLET_NOT_FOUND', message: expect.any(String) });
    expect(await transactionsOf(walletId)).toEqual([]);
  });

  test('records the X-Correlation-Id of the submission', async () => {
    const wallet = await createWallet('100.00');

    await submit(betOn(wallet), { 'x-correlation-id': 'corr-bet' });

    const [transaction] = await transactionsOf(wallet.id);
    expect(transaction!.correlation_id).toBe('corr-bet');
  });

  test('without X-Correlation-Id, a correlation id is generated', async () => {
    const wallet = await createWallet('100.00');

    await submit(betOn(wallet));

    const [transaction] = await transactionsOf(wallet.id);
    expect(transaction!.correlation_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
  });
});

describe('refused submissions', () => {
  const someWallet = (): TestWallet => ({ id: Bun.randomUUIDv7(), playerId: Bun.randomUUIDv7() });

  test.each([
    ['absent', {}],
    ['empty', { 'idempotency-key': '' }],
  ])('Idempotency-Key %s → 400 MISSING_IDEMPOTENCY_KEY', async (_case, headers) => {
    const body = betOn(someWallet());
    const response = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(400);
    expect(await readJson(response)).toEqual({ failureCode: 'MISSING_IDEMPOTENCY_KEY', message: expect.any(String) });
  });

  test('a well-formed OPENING → 400 INTERNAL_KIND_NOT_ALLOWED', async () => {
    const response = await submit(betOn(someWallet(), { kind: 'OPENING' }));

    expect(response.status).toBe(400);
    expect(await readJson(response)).toEqual({ failureCode: 'INTERNAL_KIND_NOT_ALLOWED', message: expect.any(String) });
  });

  const withMoney = (amount: unknown, currency: unknown = 'BRL'): JsonObject =>
    betOn(someWallet(), { money: { amount, currency } });

  test.each<[string, unknown]>([
    ['an unknown top-level field', betOn(someWallet(), { extra: true })],
    ['an unknown field in money', betOn(someWallet(), { money: { amount: '1.00', currency: 'BRL', extra: 1 } })],
    ['a missing field', (({ roundId: _, ...rest }) => rest)(betOn(someWallet()))],
    ['a zero BET', withMoney('0.00')],
    ['a negative amount', withMoney('-1.00')],
    ['more than 2 decimal places', withMoney('1.001')],
    ['a JSON number amount', withMoney(25)],
    ['a lowercase currency', withMoney('1.00', 'brl')],
    ['a kind out of the enum', betOn(someWallet(), { kind: 'JACKPOT' })],
    ['a lowercase kind', betOn(someWallet(), { kind: 'bet' })],
    ['a BET with a reference', betOn(someWallet(), { referenceExternalTransactionId: 'bet-0' })],
    ['a null reference', betOn(someWallet(), { referenceExternalTransactionId: null })],
    ['a malformed OPENING', betOn(someWallet(), { kind: 'OPENING', money: { amount: '0.00', currency: 'BRL' } })],
    ['a non-UUID walletId', betOn(someWallet(), { walletId: 'wallet-1' })],
    ['an empty roundId', betOn(someWallet(), { roundId: '' })],
    ['a providerId over 255 characters', betOn(someWallet(), { providerId: 'p'.repeat(256) })],
    ['a numeric gameId', betOn(someWallet(), { gameId: 7 })],
    ['an array body', [betOn(someWallet())]],
    ['malformed JSON', '{"kind":'],
  ])('%s → 400 INVALID_PAYLOAD', async (_case, body) => {
    const response = await submit(body, { 'idempotency-key': Bun.randomUUIDv7() });

    expect(response.status).toBe(400);
    expect(await readJson(response)).toEqual({ failureCode: 'INVALID_PAYLOAD', message: expect.any(String) });
  });

  test('an Idempotency-Key over 255 characters → 400 INVALID_PAYLOAD', async () => {
    const response = await submit(betOn(someWallet()), { 'idempotency-key': 'k'.repeat(256) });

    expect(response.status).toBe(400);
    expect(await readJson(response)).toMatchObject({ failureCode: 'INVALID_PAYLOAD' });
  });
});

describe('idempotency', () => {
  test('the same key and payload replay the original: same code, same balance, idempotentReplay', async () => {
    const wallet = await createWallet('100.00');
    const body = betOn(wallet);
    const original = await readJson(await submit(body));
    await submit(betOn(wallet)); // moves the balance on: the replay keeps the observed one

    const response = await submit(body);

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ ...original, idempotentReplay: true });
    expect(await walletRow(wallet.id)).toEqual({ balance: '50.00', version: 3 });
    expect(await debits(wallet.id)).toBe(2);
  });

  test('a rejection replays as a rejection, with the balance it observed', async () => {
    const wallet = await createWallet('10.00');
    const body = betOn(wallet);
    const original = await readJson(await submit(body));

    const response = await submit(body);

    expect(response.status).toBe(422);
    expect(await readJson(response)).toEqual({ ...original, idempotentReplay: true });
    expect(await transactionsOf(wallet.id)).toHaveLength(1);
  });

  test('the same key with another payload → 409 IDEMPOTENCY_CONFLICT; nothing is persisted', async () => {
    const wallet = await createWallet('100.00');
    const body = betOn(wallet);
    await submit(body);

    const response = await submit({ ...body, money: { amount: '30.00', currency: 'BRL' } });

    expect(response.status).toBe(409);
    expect(await readJson(response)).toEqual({ failureCode: 'IDEMPOTENCY_CONFLICT', message: expect.any(String) });
    expect(await walletRow(wallet.id)).toEqual({ balance: '75.00', version: 2 });
    expect(await transactionsOf(wallet.id)).toHaveLength(1);
  });

  test('the same external id with another key → 409 EXTERNAL_ID_CONFLICT; nothing is persisted', async () => {
    const wallet = await createWallet('100.00');
    const body = betOn(wallet);
    await submit(body);

    const response = await submit(body, { 'idempotency-key': 'another-key' });

    expect(response.status).toBe(409);
    expect(await readJson(response)).toEqual({ failureCode: 'EXTERNAL_ID_CONFLICT', message: expect.any(String) });
    expect(await walletRow(wallet.id)).toEqual({ balance: '75.00', version: 2 });
    expect(await transactionsOf(wallet.id)).toHaveLength(1);
  });

  test('the key is per provider: two providers with the same key are processed independently', async () => {
    const wallet = await createWallet('100.00');
    const key = `shared-${Bun.randomUUIDv7()}`;

    const first = await submit(betOn(wallet, { providerId: 'provider-a' }), { 'idempotency-key': key });
    const second = await submit(betOn(wallet, { providerId: 'provider-b' }), { 'idempotency-key': key });

    expect([first.status, second.status]).toEqual([200, 200]);
    expect((await readJson(second)).idempotentReplay).toBe(false);
    expect(await walletRow(wallet.id)).toEqual({ balance: '50.00', version: 3 });
  });
});

describe('with several violations, the first in the documented order wins', () => {
  test('a missing key beats an invalid payload', async () => {
    const response = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ extra: true }),
    });

    expect((await readJson(response)).failureCode).toBe('MISSING_IDEMPOTENCY_KEY');
  });

  test('an invalid payload beats a key conflict', async () => {
    const wallet = await createWallet('100.00');
    const body = betOn(wallet);
    await submit(body);

    const response = await submit({ ...body, extra: true }, { 'idempotency-key': keyOf(body) });

    expect((await readJson(response)).failureCode).toBe('INVALID_PAYLOAD');
  });

  test('OPENING beats a key conflict', async () => {
    const wallet = await createWallet('100.00');
    const body = betOn(wallet);
    await submit(body);

    const response = await submit({ ...body, kind: 'OPENING' }, { 'idempotency-key': keyOf(body) });

    expect((await readJson(response)).failureCode).toBe('INTERNAL_KIND_NOT_ALLOWED');
  });

  test('a key conflict beats a missing wallet', async () => {
    const wallet = await createWallet('100.00');
    const body = betOn(wallet);
    await submit(body);

    const response = await submit({ ...body, walletId: Bun.randomUUIDv7() });

    expect(response.status).toBe(409);
    expect((await readJson(response)).failureCode).toBe('IDEMPOTENCY_CONFLICT');
  });

  test('an external id conflict beats a missing wallet', async () => {
    const wallet = await createWallet('100.00');
    const body = betOn(wallet);
    await submit(body);

    const response = await submit({ ...body, walletId: Bun.randomUUIDv7() }, { 'idempotency-key': 'other-key' });

    expect((await readJson(response)).failureCode).toBe('EXTERNAL_ID_CONFLICT');
  });

  test('another player beats another currency and missing funds', async () => {
    const wallet = await createWallet('1.00');

    const response = await submit(
      betOn(wallet, { playerId: Bun.randomUUIDv7(), money: { amount: '50.00', currency: 'USD' } }),
    );

    expect((await readJson(response)).failureCode).toBe('WALLET_PLAYER_MISMATCH');
  });

  test('another currency beats missing funds', async () => {
    const wallet = await createWallet('1.00');

    const response = await submit(betOn(wallet, { money: { amount: '50.00', currency: 'USD' } }));

    expect((await readJson(response)).failureCode).toBe('CURRENCY_MISMATCH');
  });
});

describe('concurrency, with real parallel HTTP requests', () => {
  test('two simultaneous bets of 80.00 on 100.00: one PROCESSED, one REJECTED, 20.00 left, one debit', async () => {
    const wallet = await createWallet('100.00');
    const bet = (): JsonObject => betOn(wallet, { money: { amount: '80.00', currency: 'BRL' } });

    const responses = await Promise.all([submit(bet()), submit(bet())]);

    const results = await Promise.all(responses.map(readJson));
    expect(responses.map((r) => r.status).sort()).toEqual([200, 422]);
    expect(results.map((r) => r.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
    expect(results.find((r) => r.status === 'REJECTED')!.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(await walletRow(wallet.id)).toEqual({ balance: '20.00', version: 2 });
    expect(await debits(wallet.id)).toBe(1);
  });

  test('the same bet sent 50 times in parallel debits once; the rest are replays of it', async () => {
    const wallet = await createWallet('100.00');
    const body = betOn(wallet);

    const responses = await Promise.all(Array.from({ length: 50 }, () => submit(body)));

    const results = await Promise.all(responses.map(readJson));
    expect(results.filter((_, i) => responses[i]!.status !== 200)).toEqual([]);
    expect(results.filter((r) => r.idempotentReplay === false)).toHaveLength(1);
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(await walletRow(wallet.id)).toEqual({ balance: '75.00', version: 2 });
    expect(await debits(wallet.id)).toBe(1);
  });
});
