/**
 * Migration 0012 over a database that already holds wallets (#57). The suite's
 * test database is migrated while empty, so this file migrates a database of its
 * own up to 0011, seeds wallets with ledger entries, and only then applies 0012:
 * its backfill fires the deferred ledger trigger of 0003, whose pending event
 * must not block the `ALTER TABLE` that follows.
 *
 * @packageDocumentation
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { MikroORM } from '@mikro-orm/postgresql';
import { createOrmConfig } from '../../../src/database/orm.config.ts';

const MIGRATION_0011 = 'Migration0011WagerTransactionReferenceSchedule';
const MIGRATION_0012 = 'Migration0012WalletCreationIdempotency';

const adminUrl = new URL(process.env.DATABASE_URL!);
const database = `${adminUrl.pathname.slice(1)}_migration_0012`;
const databaseUrl = new URL(adminUrl);
databaseUrl.pathname = `/${database}`;

let orm: MikroORM;
let sql: SQL;

async function recreateDatabase(drop: boolean): Promise<void> {
  const admin = new SQL(adminUrl.toString());
  try {
    await admin.unsafe(`drop database if exists "${database}" with (force)`);
    if (!drop) await admin.unsafe(`create database "${database}"`);
  } finally {
    await admin.close();
  }
}

beforeAll(async () => {
  await recreateDatabase(false);
  orm = await MikroORM.init(createOrmConfig(databaseUrl.toString()));
  sql = new SQL(databaseUrl.toString());
});

afterAll(async () => {
  await orm?.close(true);
  await sql?.close();
  await recreateDatabase(true);
});

/** Inserts a processed transaction and its ledger entry, moving the wallet to `after` at `version`. */
async function recordEntry(
  tx: SQL,
  walletId: string,
  entry: { kind: string; direction: string; amount: string; before: string; after: string; version: number },
): Promise<void> {
  const transactionId = Bun.randomUUIDv7();
  await tx`
    insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
                                    wallet_id, player_id, round_id, game_id, kind, amount, currency, status,
                                    processed_at, balance_after_amount, balance_after_currency,
                                    wallet_version_observed, correlation_id, created_at)
    values (${transactionId}, 'internal', ${transactionId}, ${transactionId}, ${'f'.repeat(64)},
            ${walletId}, 'player', 'round', 'game', ${entry.kind}, ${entry.amount}, 'BRL', 'PROCESSED',
            now(), ${entry.after}, 'BRL', ${entry.version}, 'corr-0012', now())
  `;
  await tx`
    insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency,
                                       balance_before_amount, balance_before_currency,
                                       balance_after_amount, balance_after_currency, wallet_version, created_at)
    values (${Bun.randomUUIDv7()}, ${walletId}, ${transactionId}, ${entry.direction}, ${entry.amount}, 'BRL',
            ${entry.before}, 'BRL', ${entry.after}, 'BRL', ${entry.version}, now())
  `;
}

/** A wallet opened with `opening` (none when zero), then debited by `debit` if given. */
async function seedWallet(opening: string, debit?: string): Promise<string> {
  const id = Bun.randomUUIDv7();
  await sql.begin(async (tx) => {
    await tx`
      insert into wallets (id, player_id, currency, balance_amount, balance_currency, version, created_at, updated_at)
      values (${id}, ${Bun.randomUUIDv7()}, 'BRL', ${opening}, 'BRL', 1, now(), now())
    `;
    if (opening !== '0.00') {
      await recordEntry(tx, id, { kind: 'OPENING', direction: 'CREDIT', amount: opening, before: '0.00', after: opening, version: 1 });
    }
  });
  if (debit !== undefined) {
    const after = (Number(opening) - Number(debit)).toFixed(2);
    await sql.begin(async (tx) => {
      await recordEntry(tx, id, { kind: 'BET', direction: 'DEBIT', amount: debit, before: opening, after, version: 2 });
      await tx`update wallets set balance_amount = ${after}, version = 2 where id = ${id}`;
    });
  }
  return id;
}

describe('migration 0012 over existing wallets', () => {
  test('backfills the initial balance from the opening entry, or zero, and reverts', async () => {
    await orm.migrator.up({ to: MIGRATION_0011 });
    const funded = await seedWallet('100.00', '30.00');
    const empty = await seedWallet('0.00');

    const applied = await orm.migrator.up({ to: MIGRATION_0012 });

    expect(applied.map((migration) => migration.name)).toEqual([MIGRATION_0012]);
    const rows: { id: string; initial_balance_amount: string; initial_balance_currency: string }[] = await sql`
      select id, initial_balance_amount, initial_balance_currency from wallets
    `;
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(funded)).toMatchObject({ initial_balance_amount: '100.00', initial_balance_currency: 'BRL' });
    expect(byId.get(empty)).toMatchObject({ initial_balance_amount: '0.00', initial_balance_currency: 'BRL' });

    const reverted = await orm.migrator.down({ migrations: [MIGRATION_0012] });

    expect(reverted.map((migration) => migration.name)).toEqual([MIGRATION_0012]);
    const [column] = await sql`
      select count(*)::int as count from information_schema.columns
       where table_name = 'wallets' and column_name = 'initial_balance_amount'
    `;
    expect(column.count).toBe(0);
  });
});
