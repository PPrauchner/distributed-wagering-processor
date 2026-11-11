/**
 * Ledger pagination (`GET /wallets/:walletId/ledger`) and reconciliation
 * (`POST /wallets/:walletId/reconciliation`) end to end: the app runs in process
 * against the real PostgreSQL. Ends checking the ledger invariant of every
 * wallet it touched.
 *
 * @packageDocumentation
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { SQL } from 'bun';
import { createApp } from '../../../src/app.ts';
import { loadConfig } from '../../../src/config.ts';
import type { InMemoryReconciliationDivergenceCounter } from '../../../src/wallet/application/reconciliation.ts';
import { RECONCILIATION_DIVERGENCE_COUNTER } from '../../../src/wallet/interface/wallet.module.ts';
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

interface LedgerPage {
  items: JsonObject[];
  nextCursor: string | null;
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
  touchedWallets.push(id);
  return { id, playerId };
}

async function bet(wallet: TestWallet, amount = '10.00'): Promise<void> {
  const externalTransactionId = Bun.randomUUIDv7();
  const response = await fetch(`${baseUrl}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': `provider-a:${externalTransactionId}` },
    body: JSON.stringify({
      providerId: 'provider-a',
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount, currency: 'BRL' },
    }),
  });
  expect(response.status).toBe(200);
}

function getLedger(walletId: string, query: Record<string, string> = {}): Promise<Response> {
  const search = new URLSearchParams(query).toString();
  return fetch(`${baseUrl}/wallets/${walletId}/ledger${search ? `?${search}` : ''}`);
}

async function readPage(response: Response): Promise<LedgerPage> {
  expect(response.status).toBe(200);
  return (await response.json()) as LedgerPage;
}

const cursorOf = (raw: string): string => Buffer.from(raw).toString('base64url');

describe('GET /wallets/:walletId/ledger', () => {
  test('pages through every entry once, in ascending wallet version, ending with a null cursor', async () => {
    const wallet = await createWallet('100.00');
    for (let i = 0; i < 4; i++) await bet(wallet);

    const versions: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: LedgerPage = await readPage(await getLedger(wallet.id, { limit: '2', ...(cursor ? { cursor } : {}) }));
      versions.push(...page.items.map((item) => item.walletVersion as number));
      cursor = page.nextCursor;
      pages++;
    } while (cursor !== null);

    expect(versions).toEqual([1, 2, 3, 4, 5]);
    expect(pages).toBe(3);
  });

  test('entries written between pages show up further on; a page read again returns the same items', async () => {
    const wallet = await createWallet('100.00');
    await bet(wallet);
    await bet(wallet);

    const first = await readPage(await getLedger(wallet.id, { limit: '2' }));
    await bet(wallet);
    await bet(wallet);
    const second = await readPage(await getLedger(wallet.id, { limit: '2', cursor: first.nextCursor! }));
    await bet(wallet);
    const secondAgain = await readPage(await getLedger(wallet.id, { limit: '2', cursor: first.nextCursor! }));
    const third = await readPage(await getLedger(wallet.id, { limit: '2', cursor: second.nextCursor! }));

    expect(first.items.map((item) => item.walletVersion)).toEqual([1, 2]);
    expect(second.items.map((item) => item.walletVersion)).toEqual([3, 4]);
    expect(secondAgain).toEqual(second);
    expect(third.items.map((item) => item.walletVersion)).toEqual([5, 6]);
  });

  test('each item carries the entry with 2-place decimal strings; a short page has a null cursor', async () => {
    const wallet = await createWallet('100.00');
    await bet(wallet, '25.50');

    const page = await readPage(await getLedger(wallet.id));

    expect(page.nextCursor).toBeNull();
    const [opening] = await sql`select id from wager_transactions where wallet_id = ${wallet.id} and kind = 'OPENING'`;
    expect(page.items).toEqual([
      {
        id: expect.any(String),
        transactionId: opening.id,
        direction: 'CREDIT',
        money: { amount: '100.00', currency: 'BRL' },
        balanceBefore: { amount: '0.00', currency: 'BRL' },
        balanceAfter: { amount: '100.00', currency: 'BRL' },
        walletVersion: 1,
        createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      },
      {
        id: expect.any(String),
        transactionId: expect.any(String),
        direction: 'DEBIT',
        money: { amount: '25.50', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '74.50', currency: 'BRL' },
        walletVersion: 2,
        createdAt: expect.any(String),
      },
    ]);
  });

  test('a wallet without entries has an empty page', async () => {
    const wallet = await createWallet('0.00');

    expect(await readPage(await getLedger(wallet.id))).toEqual({ items: [], nextCursor: null });
  });

  test('a full last page points at an empty one', async () => {
    const wallet = await createWallet('100.00');

    const full = await readPage(await getLedger(wallet.id, { limit: '1' }));
    const empty = await readPage(await getLedger(wallet.id, { limit: '1', cursor: full.nextCursor! }));

    expect(full.items).toHaveLength(1);
    expect(empty).toEqual({ items: [], nextCursor: null });
  });

  test('the limit defaults to 50 and accepts 200', async () => {
    const wallet = await createWallet('1000.00');
    for (let i = 0; i < 50; i++) await bet(wallet, '1.00');

    const byDefault = await readPage(await getLedger(wallet.id));
    const max = await readPage(await getLedger(wallet.id, { limit: '200' }));

    expect(byDefault.items).toHaveLength(50);
    expect(byDefault.nextCursor).not.toBeNull();
    expect(max.items).toHaveLength(51);
    expect(max.nextCursor).toBeNull();
  });

  test.each([
    ['not base64url', () => '***'],
    ['another prefix', (walletId: string) => cursorOf(`v2:${walletId}:1`)],
    ['no prefix', (walletId: string) => cursorOf(`${walletId}:1`)],
    ['a non-integer version', (walletId: string) => cursorOf(`v1:${walletId}:1.5`)],
    ['a negative version', (walletId: string) => cursorOf(`v1:${walletId}:-1`)],
    ['no version', (walletId: string) => cursorOf(`v1:${walletId}`)],
    ['another wallet', () => cursorOf(`v1:${Bun.randomUUIDv7()}:1`)],
    ['an empty cursor', () => ''],
  ])('a cursor with %s → 400 INVALID_CURSOR', async (_case, cursorFor) => {
    const wallet = await createWallet('100.00');

    const response = await fetch(
      `${baseUrl}/wallets/${wallet.id}/ledger?cursor=${encodeURIComponent(cursorFor(wallet.id))}`,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ failureCode: 'INVALID_CURSOR', message: expect.any(String) });
  });

  test.each([['0'], ['201'], ['abc'], ['1.5'], ['-1'], ['']])('limit %p → 400 INVALID_PAYLOAD', async (limit) => {
    const wallet = await createWallet('100.00');

    const response = await getLedger(wallet.id, { limit });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ failureCode: 'INVALID_PAYLOAD', message: expect.any(String) });
  });

  test.each([['unknown', Bun.randomUUIDv7()], ['malformed', 'not-a-uuid']])(
    '%s wallet → 404 NOT_FOUND',
    async (_case, walletId) => {
      const response = await getLedger(walletId);

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ failureCode: 'NOT_FOUND', message: expect.any(String) });
    },
  );
});

function reconcile(walletId: string): Promise<Response> {
  return fetch(`${baseUrl}/wallets/${walletId}/reconciliation`, { method: 'POST' });
}

describe('POST /wallets/:walletId/reconciliation', () => {
  test.each([
    ['with an opening', '100.00', 3, '70.00'],
    ['without an opening', '0.00', 0, '0.00'],
  ])('a consistent wallet %s: consistent, zero difference, no gaps', async (_case, initial, entries, balance) => {
    const wallet = await createWallet(initial);
    for (let i = 0; i < entries - 1; i++) await bet(wallet, '15.00');

    const response = await reconcile(wallet.id);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: balance, currency: 'BRL' },
      calculatedBalance: { amount: balance, currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: entries,
      versionGaps: [],
    });
  });

  test('a divergence is still a 200: consistent false, counted, nothing corrected', async () => {
    const wallet = await createWallet('100.00');
    // Only this session's transaction turns the triggers off.
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update wallets set balance_amount = 99.99 where id = ${wallet.id}`;
    });
    const divergences = app.get<InMemoryReconciliationDivergenceCounter>(RECONCILIATION_DIVERGENCE_COUNTER);
    const countBefore = divergences.count;

    const response = await reconcile(wallet.id);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      storedBalance: { amount: '99.99', currency: 'BRL' },
      calculatedBalance: { amount: '100.00', currency: 'BRL' },
      difference: { amount: '-0.01', currency: 'BRL' },
      consistent: false,
      versionGaps: [],
    });
    expect(divergences.count).toBe(countBefore + 1);
    const [row] = await sql`select balance_amount::text as balance from wallets where id = ${wallet.id}`;
    expect(row.balance).toBe('99.99');
    // Divergent on purpose: out of the final invariant check.
    touchedWallets.splice(touchedWallets.indexOf(wallet.id), 1);
  });

  test.each([['unknown', Bun.randomUUIDv7()], ['malformed', 'not-a-uuid']])(
    '%s wallet → 404 NOT_FOUND',
    async (_case, walletId) => {
      const response = await reconcile(walletId);

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ failureCode: 'NOT_FOUND', message: expect.any(String) });
    },
  );
});
