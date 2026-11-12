/**
 * The structured logs of a submission, end to end against the real PostgreSQL:
 * JSON lines that carry the context of their request — correlation id,
 * transaction, wallet and provider — and never the money or the balance sent.
 * The app writes its lines to a destination of the test's own.
 *
 * @packageDocumentation
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { SQL } from 'bun';
import { createApp } from '../../../src/app.ts';
import { loadConfig } from '../../../src/config.ts';
import { expectLedgerConsistent } from '../ledger-invariant.ts';

type JsonObject = Record<string, unknown>;

let app: INestApplication;
let baseUrl: string;
let sql: SQL;
const lines: string[] = [];
const touchedWallets: string[] = [];

beforeAll(async () => {
  const config = loadConfig();
  app = await createApp(config, {
    logDestination: { write: (line: string) => lines.push(line) },
    logLevel: 'info',
  });
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
  sql = new SQL(config.databaseUrl);
});

afterAll(async () => {
  await expectLedgerConsistent(sql, touchedWallets);
  await app?.close();
  await sql?.close();
});

async function createWallet(amount: string): Promise<{ id: string; playerId: string }> {
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

async function submitBet(headers: Record<string, string> = {}): Promise<{ walletId: string; transactionId: string }> {
  const wallet = await createWallet('987.65');
  const externalTransactionId = Bun.randomUUIDv7();
  const response = await fetch(`${baseUrl}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': `key-${externalTransactionId}`, ...headers },
    body: JSON.stringify({
      providerId: 'provider-logs',
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '123.45', currency: 'BRL' },
    }),
  });
  expect(response.status).toBe(200);
  const { transactionId } = (await response.json()) as { transactionId: string };
  return { walletId: wallet.id, transactionId };
}

function linesOf(transactionId: string): { raw: string; json: JsonObject }[] {
  return lines
    .map((raw) => ({ raw, json: JSON.parse(raw) as JsonObject }))
    .filter(({ json }) => json.transactionId === transactionId);
}

describe('structured logs', () => {
  test('every line is JSON', async () => {
    await submitBet();

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  test('a submission logs its context — correlation id, transaction, wallet, provider — and no money', async () => {
    const correlationId = `corr-${Bun.randomUUIDv7()}`;

    const { walletId, transactionId } = await submitBet({ 'x-correlation-id': correlationId });

    const logged = linesOf(transactionId);
    expect(logged.length).toBeGreaterThan(0);
    expect(logged[0]!.json).toMatchObject({
      correlationId,
      transactionId,
      walletId,
      providerId: 'provider-logs',
      kind: 'BET',
      status: 'PROCESSED',
    });
    for (const { raw } of logged) {
      expect(raw).not.toContain('123.45');
      expect(raw).not.toContain('987.65');
      expect(raw).not.toContain('864.20');
    }
  });

  test('without the header, the generated correlation id is the one recorded on the transaction', async () => {
    const { transactionId } = await submitBet();

    const [row] = await sql`select correlation_id from wager_transactions where id = ${transactionId}`;
    const logged = linesOf(transactionId);
    expect(logged.length).toBeGreaterThan(0);
    expect(row.correlation_id).toEqual(expect.any(String));
    for (const { json } of logged) expect(json.correlationId).toBe(row.correlation_id);
  });
});
