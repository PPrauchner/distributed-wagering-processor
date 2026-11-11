/**
 * The concurrency suite's view of the service: a provider's client over HTTP
 * — wallets, submissions resent with the same key while the answer is a
 * transient 503 — and what the scenarios read back from the database to
 * check the outcome, the ledger invariant included.
 *
 * @packageDocumentation
 */
import { expect } from 'bun:test';
import { SQL } from 'bun';
import { loadConfig } from '../../../src/config.ts';
import { expectLedgerConsistent } from '../../integration/ledger-invariant.ts';

export type JsonObject = Record<string, unknown>;

export interface TestWallet {
  id: string;
  playerId: string;
}

export interface Answer {
  status: number;
  body: JsonObject;
}

/** The test database, which the preload pointed `DATABASE_URL` at. */
export const sql = new SQL(loadConfig().databaseUrl);

/** A transient failure's 503 is resent this many times at most. */
const MAX_TRANSIENT_RETRIES = 50;

/**
 * @param baseUrl - Any instance.
 * @param amount - The initial balance, in BRL.
 * @returns The new wallet.
 */
export async function createWallet(baseUrl: string, amount: string): Promise<TestWallet> {
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

/**
 * @param wallet - Whose wallet.
 * @param kind - `BET`, `WIN`, `LOSS`, `REFUND` or `ROLLBACK`.
 * @param overrides - Fields to replace, e.g. `money` or `referenceExternalTransactionId`.
 * @returns A submission with a new external id.
 */
export function transactionOn(wallet: TestWallet, kind: string, overrides: JsonObject = {}): JsonObject {
  return {
    providerId: 'provider-a',
    externalTransactionId: Bun.randomUUIDv7(),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: `round-${wallet.id}`,
    gameId: 'fortune-chimp',
    kind,
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  };
}

/** A `REFUND` or `ROLLBACK` of `cited`, with its amount. */
export function citing(wallet: TestWallet, kind: string, cited: JsonObject): JsonObject {
  return transactionOn(wallet, kind, { referenceExternalTransactionId: cited.externalTransactionId, money: cited.money });
}

/** The `Idempotency-Key` a provider sends: the same for every resend of a submission. */
export const keyOf = (data: JsonObject): string => `${data.providerId}:${data.externalTransactionId}`;

/** The envelope's `data` of a submission sent by the queue: the body plus its key. */
export const queued = (data: JsonObject): JsonObject => ({ ...data, idempotencyKey: keyOf(data) });

/**
 * Submits by HTTP, resending with the same key while the answer is a transient
 * 503 — the provider's retry —, until a terminal answer.
 *
 * @param baseUrl - The instance.
 * @param data - The submission.
 * @returns The terminal answer.
 * @throws {@link Error} If the instance cannot be reached, or the 503s never end.
 */
export async function submitUntilTerminal(baseUrl: string, data: JsonObject): Promise<Answer> {
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': keyOf(data) },
      body: JSON.stringify(data),
    });
    const answer = { status: response.status, body: (await response.json()) as JsonObject };
    if (answer.status !== 503) return answer;
    if (attempt >= MAX_TRANSIENT_RETRIES) throw new Error(`still 503 after ${attempt} attempts: ${keyOf(data)}`);
  }
}

export interface TransactionRow {
  id: string;
  kind: string;
  status: string;
  failure_code: string | null;
}

/** @returns The transactions recorded for the submission — never more than one. */
export async function transactionsOf(data: JsonObject): Promise<TransactionRow[]> {
  return [
    ...(await sql`
      select id, kind, status, failure_code from wager_transactions
       where provider_id = ${data.providerId as string}
         and external_transaction_id = ${data.externalTransactionId as string}
    `),
  ];
}

/** @returns The transaction once the submission ended in a terminal status; `undefined` before. */
export async function terminalTransactionOf(data: JsonObject): Promise<TransactionRow | undefined> {
  const [row] = await transactionsOf(data);
  return row === undefined || row.status === 'PENDING_REFERENCE' ? undefined : row;
}

export async function walletState(walletId: string): Promise<{ balance: string; version: number }> {
  const [row] = await sql`select balance_amount::text as balance, version from wallets where id = ${walletId}`;
  return row;
}

/** @returns The ledger entries of the wallet, its opening included, by direction. */
export async function ledgerEntries(walletId: string): Promise<{ debits: number; credits: number; total: number }> {
  const [row] = await sql`
    select count(*) filter (where direction = 'DEBIT')::int as debits,
           count(*) filter (where direction = 'CREDIT')::int as credits,
           count(*)::int as total
      from wallet_ledger_entries where wallet_id = ${walletId}
  `;
  return row;
}

/**
 * @returns How many transactions of the wallet moved its balance: the
 *   processed ones but `LOSS`, the `OPENING` included.
 */
export async function balanceMovingTransactions(walletId: string): Promise<number> {
  const [row] = await sql`
    select count(*)::int as n from wager_transactions
     where wallet_id = ${walletId} and status = 'PROCESSED' and kind <> 'LOSS'
  `;
  return row.n;
}

/**
 * Every scenario's last check, on every wallet it touched: stored balance =
 * balance rebuilt from the ledger, versions with no gap, and one entry per
 * transaction that moved the balance.
 *
 * @param walletIds - The wallets the scenario touched.
 */
export async function expectWalletsConsistent(walletIds: readonly string[]): Promise<void> {
  await expectLedgerConsistent(sql, walletIds);
  for (const walletId of walletIds) {
    expect((await ledgerEntries(walletId)).total, `wallet ${walletId}`).toBe(await balanceMovingTransactions(walletId));
  }
}
