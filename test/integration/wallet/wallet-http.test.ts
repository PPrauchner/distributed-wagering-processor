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

function postWallet(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
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

  test('a positive initial balance creates the wallet at version 1 with its opening and CREDIT entry', async () => {
    const playerId = Bun.randomUUIDv7();
    const initialBalance = { amount: '1000.00', currency: 'BRL' };

    const response = await postWallet({ playerId, initialBalance }, { 'x-correlation-id': 'corr-http' });

    expect(response.status).toBe(201);
    const body = await readJson(response);
    expect(body).toEqual({ id: expect.any(String), playerId, balance: initialBalance, version: 1 });
    touchedWallets.push(body.id as string);
    const [opening] = await sql`
      select kind, status, correlation_id from wager_transactions where wallet_id = ${body.id}
    `;
    expect(opening).toEqual({ kind: 'OPENING', status: 'PROCESSED', correlation_id: 'corr-http' });
    const [entry] = await sql`
      select direction, balance_before_amount::text as before, balance_after_amount::text as after, wallet_version
        from wallet_ledger_entries where wallet_id = ${body.id}
    `;
    expect(entry).toEqual({ direction: 'CREDIT', before: '0.00', after: '1000.00', wallet_version: body.version });
  });

  test('without X-Correlation-Id, the opening gets a generated correlation id', async () => {
    const response = await postWallet({
      playerId: Bun.randomUUIDv7(),
      initialBalance: { amount: '10.00', currency: 'BRL' },
    });

    expect(response.status).toBe(201);
    const body = await readJson(response);
    touchedWallets.push(body.id as string);
    const [opening] = await sql`select correlation_id from wager_transactions where wallet_id = ${body.id}`;
    expect(opening.correlation_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
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

describe('POST /wallets with Idempotency-Key', () => {
  const withKey = (key: string): Record<string, string> => ({ 'idempotency-key': key });

  async function countRows(walletPlayerId: string): Promise<{ wallets: number; openings: number; entries: number }> {
    const [row] = await sql`
      select count(distinct w.id)::int as wallets, count(distinct t.id)::int as openings, count(distinct e.id)::int as entries
        from wallets w
        left join wager_transactions t on t.wallet_id = w.id and t.kind = 'OPENING'
        left join wallet_ledger_entries e on e.wallet_id = w.id
       where w.player_id = ${walletPlayerId}
    `;
    return row;
  }

  test('resending the same payload with the same key replays the original 201, opening nothing new', async () => {
    const key = Bun.randomUUIDv7();
    const playerId = Bun.randomUUIDv7();
    const initialBalance = { amount: '300.00', currency: 'BRL' };

    const first = await postWallet({ playerId, initialBalance }, withKey(key));
    const replay = await postWallet({ playerId, initialBalance }, withKey(key));

    expect(first.status).toBe(201);
    const created = await readJson(first);
    touchedWallets.push(created.id as string);
    expect(created).toEqual({ id: expect.any(String), playerId, balance: initialBalance, version: 1, idempotentReplay: false });
    expect(replay.status).toBe(201);
    expect(await readJson(replay)).toEqual({ ...created, idempotentReplay: true });
    expect(await countRows(playerId)).toEqual({ wallets: 1, openings: 1, entries: 1 });
  });

  test('a replay after the wallet moved still answers with the initial balance at version 1', async () => {
    const key = Bun.randomUUIDv7();
    const playerId = Bun.randomUUIDv7();
    const initialBalance = { amount: '100.00', currency: 'BRL' };
    const created = await readJson(await postWallet({ playerId, initialBalance }, withKey(key)));
    touchedWallets.push(created.id as string);
    const bet = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': Bun.randomUUIDv7() },
      body: JSON.stringify({
        providerId: 'provider-a',
        externalTransactionId: Bun.randomUUIDv7(),
        playerId,
        walletId: created.id,
        roundId: 'round',
        gameId: 'game',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
      }),
    });
    expect(bet.status).toBe(200);

    const replay = await postWallet({ playerId, initialBalance }, withKey(key));

    expect(await readJson(replay)).toEqual({ ...created, idempotentReplay: true });
    const current = await readJson(await fetch(`${baseUrl}/wallets/${created.id}`));
    expect(current).toMatchObject({ balance: { amount: '75.00', currency: 'BRL' }, version: 2 });
  });

  test('parallel requests with the same key and payload: one creation, every other one a replay', async () => {
    const key = Bun.randomUUIDv7();
    const playerId = Bun.randomUUIDv7();
    const initialBalance = { amount: '50.00', currency: 'BRL' };

    const responses = await Promise.all(
      Array.from({ length: 8 }, () => postWallet({ playerId, initialBalance }, withKey(key))),
    );

    expect(responses.map((r) => r.status)).toEqual(Array(8).fill(201));
    const bodies = await Promise.all(responses.map(readJson));
    touchedWallets.push(bodies[0]!.id as string);
    expect(bodies.filter((b) => b.idempotentReplay === false)).toHaveLength(1);
    expect(new Set(bodies.map((b) => b.id)).size).toBe(1);
    expect(await countRows(playerId)).toEqual({ wallets: 1, openings: 1, entries: 1 });
  });

  const original = { playerId: 'player-original', initialBalance: { amount: '10.00', currency: 'BRL' } };
  test.each([
    ['another playerId', { ...original, playerId: 'player-other' }],
    ['another amount', { ...original, initialBalance: { amount: '10.01', currency: 'BRL' } }],
    ['another currency', { ...original, initialBalance: { amount: '10.00', currency: 'USD' } }],
  ])('the same key with %s → 409 IDEMPOTENCY_CONFLICT', async (_case, changed) => {
    const key = Bun.randomUUIDv7();
    const suffix = Bun.randomUUIDv7();
    const created = await readJson(
      await postWallet({ ...original, playerId: `${original.playerId}-${suffix}` }, withKey(key)),
    );
    touchedWallets.push(created.id as string);

    const response = await postWallet({ ...changed, playerId: `${changed.playerId}-${suffix}` }, withKey(key));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ failureCode: 'IDEMPOTENCY_CONFLICT', message: expect.any(String) });
  });

  test('a new key for a player and currency that already have a wallet → 409 WALLET_ALREADY_EXISTS', async () => {
    const playerId = Bun.randomUUIDv7();
    const existing = await readJson(await postWallet({ playerId, initialBalance: zeroBrl }, withKey(Bun.randomUUIDv7())));
    touchedWallets.push(existing.id as string);

    const response = await postWallet({ playerId, initialBalance: zeroBrl }, withKey(Bun.randomUUIDv7()));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      failureCode: 'WALLET_ALREADY_EXISTS',
      message: expect.any(String),
      walletId: existing.id,
    });
  });

  test('an empty key is refused like an empty key on a submission, and creates nothing', async () => {
    const playerId = Bun.randomUUIDv7();

    const response = await postWallet({ playerId, initialBalance: zeroBrl }, withKey(''));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ failureCode: 'MISSING_IDEMPOTENCY_KEY', message: expect.any(String) });
    expect((await countRows(playerId)).wallets).toBe(0);
  });

  test('a conflicting key wins over the wallet that already exists for that player and currency', async () => {
    const key = Bun.randomUUIDv7();
    const playerId = Bun.randomUUIDv7();
    const keyed = await readJson(await postWallet({ playerId, initialBalance: zeroBrl }, withKey(key)));
    const other = await readJson(
      await postWallet({ playerId, initialBalance: { amount: '0.00', currency: 'USD' } }),
    );
    touchedWallets.push(keyed.id as string, other.id as string);

    const response = await postWallet({ playerId, initialBalance: { amount: '0.00', currency: 'USD' } }, withKey(key));

    expect(response.status).toBe(409);
    expect((await readJson(response)).failureCode).toBe('IDEMPOTENCY_CONFLICT');
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
