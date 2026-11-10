/**
 * Wallet HTTP API end to end: the app runs in process against the real
 * PostgreSQL and is driven by real HTTP requests.
 *
 * @packageDocumentation
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { SQL } from 'bun';
import { createApp } from '../../../src/app.ts';
import { loadConfig } from '../../../src/config.ts';

let app: INestApplication;
let baseUrl: string;
let sql: SQL;

beforeAll(async () => {
  const config = loadConfig();
  app = await createApp(config);
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
  sql = new SQL(config.databaseUrl);
});

afterAll(async () => {
  await app?.close();
  await sql?.close();
});

function postWallet(body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const zeroBrl = { amount: '0.00', currency: 'BRL' };

type JsonObject = Record<string, unknown>;

async function readJson(response: Response): Promise<JsonObject> {
  return (await response.json()) as JsonObject;
}

describe('POST /wallets', () => {
  test('creates a zero-balance wallet at version 1', async () => {
    const playerId = Bun.randomUUIDv7();

    const response = await postWallet({ playerId, initialBalance: zeroBrl });

    expect(response.status).toBe(201);
    const body = await readJson(response);
    expect(body).toEqual({ id: expect.any(String), playerId, balance: zeroBrl, version: 1 });
    expect(body.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/); // UUIDv7
  });

  test('a second wallet for the same player and currency is a conflict that names the existing one', async () => {
    const playerId = Bun.randomUUIDv7();
    const first = await readJson(await postWallet({ playerId, initialBalance: zeroBrl }));

    const response = await postWallet({ playerId, initialBalance: zeroBrl });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      failureCode: 'WALLET_ALREADY_EXISTS',
      message: expect.any(String),
      walletId: first.id,
    });
  });

  test('two simultaneous creations: exactly one 201 and one 409', async () => {
    const playerId = Bun.randomUUIDv7();

    const responses = await Promise.all([
      postWallet({ playerId, initialBalance: zeroBrl }),
      postWallet({ playerId, initialBalance: zeroBrl }),
    ]);

    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    const [createdResponse, conflictResponse] = responses.sort((a, b) => a.status - b.status);
    const created = await readJson(createdResponse!);
    const conflict = await readJson(conflictResponse!);
    expect(conflict.walletId).toBe(created.id);
  });

  test('a positive initial balance is refused, says why and creates nothing', async () => {
    const playerId = Bun.randomUUIDv7();

    const response = await postWallet({ playerId, initialBalance: { amount: '10.00', currency: 'BRL' } });

    expect(response.status).toBe(400);
    const body = await readJson(response);
    expect(body.failureCode).toBe('INVALID_PAYLOAD');
    expect(body.message).toMatch(/not supported/);
    const [row] = await sql`select count(*)::int as count from wallets where player_id = ${playerId}`;
    expect(row.count).toBe(0);
  });

  const valid = (): Record<string, unknown> => ({
    playerId: Bun.randomUUIDv7(),
    initialBalance: { ...zeroBrl },
  });
  const withAmount = (amount: unknown): unknown => ({ ...valid(), initialBalance: { amount, currency: 'BRL' } });

  test.each([
    ['negative balance', withAmount('-1.00')],
    ['NaN', withAmount('NaN')],
    ['Infinity', withAmount('Infinity')],
    ['scientific notation', withAmount('1e2')],
    ['empty amount', withAmount('')],
    ['more than 2 decimal places', withAmount('1.234')],
    ['16 integer digits', withAmount('1000000000000000.00')],
    ['JSON number amount', withAmount(0)],
    ['lowercase currency', { ...valid(), initialBalance: { amount: '0.00', currency: 'brl' } }],
    ['missing currency', { ...valid(), initialBalance: { amount: '0.00' } }],
    ['missing initialBalance', { playerId: Bun.randomUUIDv7() }],
    ['initialBalance not an object', { ...valid(), initialBalance: '0.00' }],
    ['missing playerId', { initialBalance: zeroBrl }],
    ['empty playerId', { ...valid(), playerId: '' }],
    ['playerId over 255 characters', { ...valid(), playerId: 'p'.repeat(256) }],
    ['numeric playerId', { ...valid(), playerId: 42 }],
    ['unknown top-level field', { ...valid(), extra: true }],
    ['unknown nested field', { ...valid(), initialBalance: { ...zeroBrl, extra: true } }],
    ['array body', [valid()]],
    ['null body', 'null'],
    ['malformed JSON', '{"playerId":'],
  ])('%s → 400 INVALID_PAYLOAD', async (_case, body) => {
    const response = await postWallet(body);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ failureCode: 'INVALID_PAYLOAD', message: expect.any(String) });
  });

  test('a body over the size limit is a client error that keeps its 4xx status', async () => {
    const response = await postWallet({ playerId: 'p'.repeat(200_000), initialBalance: zeroBrl });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ failureCode: 'INVALID_PAYLOAD', message: expect.any(String) });
  });

  test('a non-UUID player id up to 255 characters is accepted', async () => {
    const response = await postWallet({ playerId: `player-${Bun.randomUUIDv7()}`, initialBalance: zeroBrl });

    expect(response.status).toBe(201);
  });
});

describe('GET /wallets/:id', () => {
  test('returns the wallet with a 2-place decimal balance and its version', async () => {
    const playerId = Bun.randomUUIDv7();
    const created = await readJson(await postWallet({ playerId, initialBalance: zeroBrl }));

    const response = await fetch(`${baseUrl}/wallets/${created.id}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: created.id, playerId, balance: zeroBrl, version: 1 });
  });

  test.each([['unknown', Bun.randomUUIDv7()], ['malformed', 'not-a-uuid']])(
    '%s id → 404 NOT_FOUND',
    async (_case, id) => {
      const response = await fetch(`${baseUrl}/wallets/${id}`);

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ failureCode: 'NOT_FOUND', message: expect.any(String) });
    },
  );
});
