/**
 * The wager transaction queries end to end, by internal id and by the
 * provider's external id: the app runs in process against the real PostgreSQL.
 * A query answers 200 with the outcome of the transaction — the balance it
 * observed, not the wallet's current one — and its identity, whatever its
 * status; an unknown id answers 404 `NOT_FOUND`.
 *
 * @packageDocumentation
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../../../src/app.ts';
import { loadConfig } from '../../../src/config.ts';

let app: INestApplication;
let baseUrl: string;

beforeAll(async () => {
  app = await createApp(loadConfig());
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
});

afterAll(async () => {
  await app?.close();
});

type JsonObject = Record<string, unknown>;

interface TestWallet {
  id: string;
  playerId: string;
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

function betOn(wallet: TestWallet, amount: string): JsonObject {
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

async function submit(body: JsonObject): Promise<JsonObject> {
  const response = await fetch(`${baseUrl}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': `key-${body.externalTransactionId}` },
    body: JSON.stringify(body),
  });
  return (await response.json()) as JsonObject;
}

async function get(path: string): Promise<{ status: number; body: JsonObject }> {
  const response = await fetch(`${baseUrl}${path}`);
  return { status: response.status, body: (await response.json()) as JsonObject };
}

describe('GET /wagering/transactions/:transactionId', () => {
  test('a processed BET: 200 with its outcome and identity, without idempotentReplay', async () => {
    const wallet = await createWallet('100.00');
    const bet = betOn(wallet, '30.00');
    const submitted = await submit(bet);

    const { status, body } = await get(`/wagering/transactions/${submitted.transactionId}`);

    expect(status).toBe(200);
    expect(body).toEqual({
      transactionId: submitted.transactionId,
      status: 'PROCESSED',
      balance: { amount: '70.00', currency: 'BRL' },
      providerId: 'provider-a',
      externalTransactionId: bet.externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '30.00', currency: 'BRL' },
    });
    expect(body.balance).toEqual(submitted.balance);
  });

  test('a rejected BET: 200 with REJECTED, its failure code and the balance observed at the rejection', async () => {
    const wallet = await createWallet('10.00');
    const submitted = await submit(betOn(wallet, '30.00'));

    const { status, body } = await get(`/wagering/transactions/${submitted.transactionId}`);

    expect(status).toBe(200);
    expect(body.status).toBe('REJECTED');
    expect(body.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(body.balance).toEqual({ amount: '10.00', currency: 'BRL' });
  });

  test('after another transaction moves the balance, an old one still shows the balance it observed', async () => {
    const wallet = await createWallet('100.00');
    const first = await submit(betOn(wallet, '30.00'));
    await submit(betOn(wallet, '20.00'));

    const { body } = await get(`/wagering/transactions/${first.transactionId}`);

    expect(body.balance).toEqual({ amount: '70.00', currency: 'BRL' });
  });

  test('an unknown id: 404 NOT_FOUND', async () => {
    const { status, body } = await get(`/wagering/transactions/${Bun.randomUUIDv7()}`);

    expect(status).toBe(404);
    expect(body).toEqual({ failureCode: 'NOT_FOUND', message: expect.any(String) });
  });

  test('an id that is not a UUID: 404 NOT_FOUND', async () => {
    const { status, body } = await get('/wagering/transactions/not-a-uuid');

    expect(status).toBe(404);
    expect(body).toEqual({ failureCode: 'NOT_FOUND', message: expect.any(String) });
  });
});

describe('GET /providers/:providerId/wagering/transactions/:externalTransactionId', () => {
  test('answers the same body as the query by internal id', async () => {
    const wallet = await createWallet('100.00');
    const bet = betOn(wallet, '30.00');
    const submitted = await submit(bet);

    const byExternalId = await get(`/providers/provider-a/wagering/transactions/${bet.externalTransactionId}`);
    const byInternalId = await get(`/wagering/transactions/${submitted.transactionId}`);

    expect(byExternalId.status).toBe(200);
    expect(byExternalId.body).toEqual(byInternalId.body);
  });

  test("another provider's external id: 404 NOT_FOUND", async () => {
    const wallet = await createWallet('100.00');
    const bet = betOn(wallet, '30.00');
    await submit(bet);

    const { status, body } = await get(`/providers/provider-b/wagering/transactions/${bet.externalTransactionId}`);

    expect(status).toBe(404);
    expect(body).toEqual({ failureCode: 'NOT_FOUND', message: expect.any(String) });
  });
});
