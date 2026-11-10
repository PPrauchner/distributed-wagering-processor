/**
 * Audit of the submissions `POST /wagering/transactions` does not admit: each
 * refusal leaves exactly one row in `rejected_submissions`, with what could be
 * extracted from it, and the HTTP response does not change; a replay leaves
 * none. The table itself is append-only, proven by raw SQL. Ends checking the
 * ledger invariant of every wallet it touched.
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

const someWallet = (): TestWallet => ({ id: Bun.randomUUIDv7(), playerId: Bun.randomUUIDv7() });

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

/** Submits under its own correlation id, which tells its audit rows apart. */
async function submit(
  body: unknown,
  headers: Record<string, string>,
): Promise<{ response: Response; correlationId: string }> {
  const correlationId = Bun.randomUUIDv7();
  const response = await fetch(`${baseUrl}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-correlation-id': correlationId, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { response, correlationId };
}

async function auditRows(correlationId: string): Promise<JsonObject[]> {
  return sql`
    select provider_id, idempotency_key, external_transaction_id, payload_hash, failure_code, channel,
           message_id, correlation_id, received_at
      from rejected_submissions where correlation_id = ${correlationId}
  `;
}

const keyed = (key: string = Bun.randomUUIDv7()): Record<string, string> => ({ 'idempotency-key': key });

describe('each refused submission leaves exactly one row', () => {
  test('INVALID_PAYLOAD: what could be extracted, without a hash', async () => {
    const body = betOn(someWallet(), { extra: true });
    const key = Bun.randomUUIDv7();

    const { response, correlationId } = await submit(body, keyed(key));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ failureCode: 'INVALID_PAYLOAD', message: expect.any(String) });
    expect(await auditRows(correlationId)).toEqual([
      {
        provider_id: 'provider-a',
        idempotency_key: key,
        external_transaction_id: body.externalTransactionId,
        payload_hash: null,
        failure_code: 'INVALID_PAYLOAD',
        channel: 'HTTP',
        message_id: null,
        correlation_id: correlationId,
        received_at: expect.any(Date),
      },
    ]);
  });

  test('INVALID_PAYLOAD from malformed JSON: no field but the headers', async () => {
    const key = Bun.randomUUIDv7();

    const { response, correlationId } = await submit('{"kind":', keyed(key));

    expect(response.status).toBe(400);
    expect(await auditRows(correlationId)).toEqual([
      expect.objectContaining({
        provider_id: null,
        idempotency_key: key,
        external_transaction_id: null,
        failure_code: 'INVALID_PAYLOAD',
      }),
    ]);
  });

  test('MISSING_IDEMPOTENCY_KEY: no key', async () => {
    const { response, correlationId } = await submit(betOn(someWallet()), {});

    expect(response.status).toBe(400);
    expect(await auditRows(correlationId)).toEqual([
      expect.objectContaining({ idempotency_key: null, provider_id: 'provider-a', failure_code: 'MISSING_IDEMPOTENCY_KEY' }),
    ]);
  });

  test('INTERNAL_KIND_NOT_ALLOWED: with the payload hash', async () => {
    const { response, correlationId } = await submit(betOn(someWallet(), { kind: 'OPENING' }), keyed());

    expect(response.status).toBe(400);
    expect(await auditRows(correlationId)).toEqual([
      expect.objectContaining({ failure_code: 'INTERNAL_KIND_NOT_ALLOWED', payload_hash: expect.stringMatching(/^[0-9a-f]{64}$/) }),
    ]);
  });

  test('WALLET_NOT_FOUND', async () => {
    const { response, correlationId } = await submit(betOn(someWallet()), keyed());

    expect(response.status).toBe(422);
    expect(await auditRows(correlationId)).toEqual([
      expect.objectContaining({ failure_code: 'WALLET_NOT_FOUND', payload_hash: expect.stringMatching(/^[0-9a-f]{64}$/) }),
    ]);
  });

  test('IDEMPOTENCY_CONFLICT, and EXTERNAL_ID_CONFLICT', async () => {
    const wallet = await createWallet('100.00');
    const body = betOn(wallet);
    const key = Bun.randomUUIDv7();
    await submit(body, keyed(key));

    const conflict = await submit({ ...body, money: { amount: '1.00', currency: 'BRL' } }, keyed(key));
    const externalIdConflict = await submit(body, keyed());

    expect(conflict.response.status).toBe(409);
    expect(await auditRows(conflict.correlationId)).toEqual([
      expect.objectContaining({ failure_code: 'IDEMPOTENCY_CONFLICT', idempotency_key: key }),
    ]);
    expect(externalIdConflict.response.status).toBe(409);
    expect(await auditRows(externalIdConflict.correlationId)).toEqual([
      expect.objectContaining({ failure_code: 'EXTERNAL_ID_CONFLICT', external_transaction_id: body.externalTransactionId }),
    ]);
  });

  test('every attempt is a row: the same refusal twice leaves two', async () => {
    const correlationId = Bun.randomUUIDv7();
    const body = betOn(someWallet());
    const headers = { ...keyed(), 'x-correlation-id': correlationId };

    await submit(body, headers);
    await submit(body, headers);

    expect(await auditRows(correlationId)).toHaveLength(2);
  });
});

describe('admitted submissions leave no row', () => {
  test('neither the original nor its replay, nor a rejection', async () => {
    const wallet = await createWallet('30.00');
    const correlationId = Bun.randomUUIDv7();
    const headers = { ...keyed(), 'x-correlation-id': correlationId };
    const body = betOn(wallet);

    expect((await submit(body, headers)).response.status).toBe(200);
    expect((await submit(body, headers)).response.status).toBe(200);
    expect((await submit(betOn(wallet), { ...keyed(), 'x-correlation-id': correlationId })).response.status).toBe(422);

    expect(await auditRows(correlationId)).toEqual([]);
  });

  test('a refusal elsewhere — a wallet creation — leaves none', async () => {
    const correlationId = Bun.randomUUIDv7();

    const response = await fetch(`${baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-correlation-id': correlationId },
      body: JSON.stringify({ extra: true }),
    });

    expect(response.status).toBe(400);
    expect(await auditRows(correlationId)).toEqual([]);
  });
});

describe('rejected_submissions in the schema', () => {
  test('is append-only: UPDATE and DELETE are refused', async () => {
    const { correlationId } = await submit(betOn(someWallet()), keyed());

    expect(sql`update rejected_submissions set failure_code = 'X' where correlation_id = ${correlationId}`).rejects.toThrow(
      /rejected_submissions_append_only/,
    );
    expect(sql`delete from rejected_submissions where correlation_id = ${correlationId}`).rejects.toThrow(
      /rejected_submissions_append_only/,
    );
  });

  test('has no uniqueness and no foreign key', async () => {
    const [row] = await sql`
      select count(*)::int as n from information_schema.table_constraints
       where table_name = 'rejected_submissions' and constraint_type in ('UNIQUE', 'FOREIGN KEY')
    `;
    expect(row.n).toBe(0);
  });
});
