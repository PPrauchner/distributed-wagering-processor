/**
 * `wager_transactions` guaranteed by the schema, proven by raw SQL: idempotency
 * key and external id unique per provider, the static coherence `CHECK`s of
 * every kind and status, and the terminal row that never changes. The code path
 * is not trusted to hold any of it.
 *
 * @packageDocumentation
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { loadConfig } from '../../../src/config.ts';

let sql: SQL;
let walletId: string;

beforeAll(async () => {
  sql = new SQL(loadConfig().databaseUrl);
  walletId = Bun.randomUUIDv7();
  await sql`
    insert into wallets (id, player_id, currency, balance_amount, balance_currency, version, created_at, updated_at, initial_balance_amount, initial_balance_currency)
    values (${walletId}, ${Bun.randomUUIDv7()}, 'BRL', '0.00', 'BRL', 1, now(), now(), '0.00', 'BRL')
  `;
});

afterAll(async () => {
  await sql?.close();
});

type Row = Record<string, string | number | Date | null>;

/** A `PROCESSED` `BET`, coherent; overrides make it anything else. */
function transactionRow(overrides: Row = {}): Row {
  const id = Bun.randomUUIDv7();
  return {
    id,
    provider_id: 'provider-a',
    external_transaction_id: id,
    idempotency_key: id,
    payload_hash: 'a'.repeat(64),
    wallet_id: walletId,
    player_id: 'player',
    round_id: 'round',
    game_id: 'game',
    kind: 'BET',
    amount: '10.00',
    currency: 'BRL',
    reference_external_transaction_id: null,
    status: 'PROCESSED',
    failure_code: null,
    processed_at: new Date(),
    balance_after_amount: '90.00',
    balance_after_currency: 'BRL',
    wallet_version_observed: 2,
    correlation_id: 'corr',
    created_at: new Date(),
    ...overrides,
  };
}

async function insert(overrides: Row = {}): Promise<string> {
  const row = transactionRow(overrides);
  await sql`insert into wager_transactions ${sql(row)}`;
  return row.id as string;
}

const rejected: Row = {
  status: 'REJECTED',
  failure_code: 'INSUFFICIENT_FUNDS',
  processed_at: null,
};
const failed: Row = {
  status: 'FAILED',
  failure_code: 'INFRA_UNEXPECTED',
  processed_at: null,
  balance_after_amount: null,
  balance_after_currency: null,
  wallet_version_observed: null,
};
const pendingRefund: Row = {
  kind: 'REFUND',
  reference_external_transaction_id: 'bet-1',
  status: 'PENDING_REFERENCE',
  processed_at: null,
  balance_after_amount: null,
  balance_after_currency: null,
  wallet_version_observed: null,
  next_attempt_at: new Date(),
};

describe('uniqueness per provider', () => {
  test('an idempotency key is unique per provider, and free across providers', async () => {
    const key = Bun.randomUUIDv7();
    await insert({ idempotency_key: key });

    await expect(insert({ idempotency_key: key })).rejects.toThrow(
      /wager_transactions_provider_idempotency_key_unique/,
    );
    await insert({ idempotency_key: key, provider_id: 'provider-b' });
  });

  test('an external transaction id is unique per provider, and free across providers', async () => {
    const externalId = Bun.randomUUIDv7();
    await insert({ external_transaction_id: externalId });

    await expect(insert({ external_transaction_id: externalId })).rejects.toThrow(
      /wager_transactions_provider_external_id_unique/,
    );
    await insert({ external_transaction_id: externalId, provider_id: 'provider-b' });
  });
});

describe('coherence CHECKs', () => {
  test.each<[string, Row, RegExp]>([
    ['a BET with a reference', { reference_external_transaction_id: 'x' }, /wager_transactions_reference_by_kind/],
    [
      'a LOSS with a reference',
      { kind: 'LOSS', reference_external_transaction_id: 'x' },
      /wager_transactions_reference_by_kind/,
    ],
    [
      'an OPENING with a reference',
      { kind: 'OPENING', reference_external_transaction_id: 'x' },
      /wager_transactions_reference_by_kind/,
    ],
    ['a REFUND without a reference', { kind: 'REFUND' }, /wager_transactions_reference_by_kind/],
    ['a ROLLBACK without a reference', { kind: 'ROLLBACK' }, /wager_transactions_reference_by_kind/],
    ['a BET of zero', { amount: '0.00' }, /wager_transactions_amount_positive/],
    ['a LOSS below zero', { kind: 'LOSS', amount: '-1.00' }, /wager_transactions_amount_positive/],
    ['a PENDING row', { ...pendingRefund, status: 'PENDING' }, /wager_transactions_not_pending/],
    [
      'a PENDING_REFERENCE BET',
      { ...pendingRefund, kind: 'BET', reference_external_transaction_id: null },
      /wager_transactions_pending_reference_kind/,
    ],
    ['PROCESSED without processed_at', { processed_at: null }, /wager_transactions_processed_at/],
    ['REJECTED with processed_at', { ...rejected, processed_at: new Date() }, /wager_transactions_processed_at/],
    ['REJECTED without a failure code', { ...rejected, failure_code: null }, /wager_transactions_failure_code/],
    ['PROCESSED with a failure code', { failure_code: 'X' }, /wager_transactions_failure_code/],
    ['PROCESSED without the observed balance', { balance_after_amount: null }, /wager_transactions_observed_balance/],
    [
      'REJECTED without the observed version',
      { ...rejected, wallet_version_observed: null },
      /wager_transactions_observed_balance/,
    ],
    ['FAILED with an observed balance', { ...failed, balance_after_amount: '1.00' }, /wager_transactions_observed_balance/],
    [
      'PENDING_REFERENCE with an observed version',
      { ...pendingRefund, wallet_version_observed: 1 },
      /wager_transactions_observed_balance/,
    ],
    [
      'PENDING_REFERENCE with no next attempt',
      { ...pendingRefund, next_attempt_at: null },
      /wager_transactions_pending_reference_schedule/,
    ],
    ['a negative attempt count', { attempts: -1 }, /wager_transactions_attempts_non_negative/],
  ])('refuses %s', async (_case, overrides, constraint) => {
    await expect(insert(overrides)).rejects.toThrow(constraint);
  });

  test.each<[string, Row]>([
    ['a PROCESSED BET', {}],
    ['a REJECTED BET with its observed balance', rejected],
    ['a FAILED BET with no observed balance', failed],
    ['a PENDING_REFERENCE REFUND', pendingRefund],
    ['a WIN with no reference', { kind: 'WIN' }],
    ['a WIN with a reference', { kind: 'WIN', reference_external_transaction_id: 'bet-1' }],
    ['a LOSS of zero', { kind: 'LOSS', amount: '0.00' }],
  ])('accepts %s', async (_case, overrides) => {
    const id = await insert(overrides);

    const [row] = await sql`select count(*)::int as n from wager_transactions where id = ${id}`;
    expect(row.n).toBe(1);
  });

  test('the correlation id is required', async () => {
    await expect(insert({ correlation_id: null })).rejects.toThrow(/correlation_id/);
  });
});

describe('the reference', () => {
  test('reference_transaction_id must point at an existing transaction', async () => {
    await expect(
      insert({ kind: 'WIN', reference_external_transaction_id: 'bet-1', reference_transaction_id: Bun.randomUUIDv7() }),
    ).rejects.toThrow(/wager_transactions_reference_fk/);
  });

  test('accepts a WIN pointing at an existing BET', async () => {
    const betId = await insert();

    await insert({ kind: 'WIN', reference_external_transaction_id: 'bet-1', reference_transaction_id: betId });
  });

  test('accepts a PENDING_REFERENCE WIN with nothing observed', async () => {
    await insert({ ...pendingRefund, kind: 'WIN' });
  });
});

describe('the failure message', () => {
  test('only goes with a failure code', async () => {
    await expect(insert({ failure_message: 'x' })).rejects.toThrow(/wager_transactions_failure_message/);
  });

  test('is kept on a rejection', async () => {
    const id = await insert({ ...rejected, failure_code: 'REFERENCE_MISMATCH', failure_message: 'another roundId' });

    const [row] = await sql`select failure_message from wager_transactions where id = ${id}`;
    expect(row.failure_message).toBe('another roundId');
  });
});

describe('a terminal transaction never changes', () => {
  test.each<[string, Row]>([
    ['PROCESSED', {}],
    ['REJECTED', rejected],
    ['FAILED', failed],
  ])('a %s row refuses any update', async (_case, overrides) => {
    const id = await insert(overrides);

    await expect(sql`update wager_transactions set round_id = round_id where id = ${id}`).rejects.toThrow(
      /wager_transactions_terminal_immutable/,
    );
  });

  test('no row is ever deleted', async () => {
    const id = await insert(pendingRefund);

    await expect(sql`delete from wager_transactions where id = ${id}`).rejects.toThrow(
      /wager_transactions_immutable/,
    );
  });

  test('the table is never truncated', async () => {
    await expect(sql`truncate wager_transactions cascade`).rejects.toThrow(/wager_transactions_immutable/);
  });

  test('a PENDING_REFERENCE row may leave for a terminal status', async () => {
    const id = await insert(pendingRefund);

    await sql`
      update wager_transactions
         set status = 'PROCESSED', processed_at = now(), balance_after_amount = '10.00',
             balance_after_currency = 'BRL', wallet_version_observed = 2
       where id = ${id}
    `;

    const [row] = await sql`select status from wager_transactions where id = ${id}`;
    expect(row.status).toBe('PROCESSED');
  });

  test('a PENDING_REFERENCE row may be rescheduled, staying pending', async () => {
    const id = await insert(pendingRefund);

    await sql`
      update wager_transactions set attempts = attempts + 1, next_attempt_at = now() + interval '2 seconds'
       where id = ${id}
    `;

    const [row] = await sql`select status, attempts from wager_transactions where id = ${id}`;
    expect(row).toEqual({ status: 'PENDING_REFERENCE', attempts: 1 });
  });

  test.each([
    ['idempotency_key', `'other-key'`],
    ['payload_hash', `'${'b'.repeat(64)}'`],
    ['amount', `'99.00'`],
    ['kind', `'ROLLBACK'`],
    ['wallet_id', `'${Bun.randomUUIDv7()}'`],
    ['correlation_id', `'other'`],
  ])('the identity column %s never changes, even while pending', async (column, value) => {
    const id = await insert(pendingRefund);

    await expect(sql.unsafe(`update wager_transactions set ${column} = ${value} where id = '${id}'`)).rejects.toThrow(
      /wager_transactions_identity_immutable/,
    );
  });
});
