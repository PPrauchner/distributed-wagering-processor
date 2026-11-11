/**
 * Wallet persistence against a real PostgreSQL: reversible migrations, the
 * `defineEntity` mappings of the wallet, the opening and its ledger entry with
 * `Money` as an embeddable, and the wallet's own schema
 * invariants proven by raw SQL — the code path is not trusted to hold them.
 *
 * @packageDocumentation
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../../../src/config.ts';
import { createOrmConfig } from '../../../src/database/orm.config.ts';
import { Money } from '../../../src/shared/domain/money.ts';
import { Wallet } from '../../../src/wallet/domain/wallet.ts';
import { LedgerDirection, WalletLedgerEntry } from '../../../src/wallet/domain/wallet-ledger-entry.ts';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../src/wagering/domain/wager-transaction.ts';
import { expectLedgerConsistent } from '../ledger-invariant.ts';

let orm: MikroORM;
let sql: SQL;

beforeAll(async () => {
  const { databaseUrl } = loadConfig();
  orm = await MikroORM.init(createOrmConfig(databaseUrl));
  sql = new SQL(databaseUrl);
});

afterAll(async () => {
  await orm?.close(true);
  await sql?.close();
});

async function tableExists(name: string): Promise<boolean> {
  const [row] = await sql`select to_regclass(${name}) is not null as exists`;
  return row.exists;
}

async function insertWallet(overrides: Record<string, unknown> = {}): Promise<string> {
  const row: Record<string, unknown> = {
    id: Bun.randomUUIDv7(),
    player_id: Bun.randomUUIDv7(),
    currency: 'BRL',
    balance_amount: '0.00',
    balance_currency: 'BRL',
    version: 1,
    initial_balance_amount: '0.00',
    creation_idempotency_key: null,
    creation_payload_hash: null,
    ...overrides,
  };
  const initialCurrency = row.initial_balance_currency ?? row.currency;
  await sql`
    insert into wallets (id, player_id, currency, balance_amount, balance_currency, version, created_at, updated_at,
                         initial_balance_amount, initial_balance_currency, creation_idempotency_key, creation_payload_hash)
    values (${row.id}, ${row.player_id}, ${row.currency}, ${row.balance_amount}, ${row.balance_currency}, ${row.version}, now(), now(),
            ${row.initial_balance_amount}, ${initialCurrency}, ${row.creation_idempotency_key}, ${row.creation_payload_hash})
  `;
  return row.id as string;
}

const ALL_MIGRATIONS = [
  'Migration0001Wallets',
  'Migration0002WagerTransactions',
  'Migration0003WalletLedger',
  'Migration0004WalletIdentity',
  'Migration0005WagerTransactionInvariants',
  'Migration0006RejectedSubmissions',
  'Migration0007OutboxMessages',
  'Migration0008WagerTransactionReference',
  'Migration0009WagerTransactionSingleReversal',
  'Migration0010InboxMessages',
  'Migration0011WagerTransactionReferenceSchedule',
  'Migration0012WalletCreationIdempotency',
];
const TABLES = [
  'wallets',
  'wager_transactions',
  'wallet_ledger_entries',
  'rejected_submissions',
  'outbox_messages',
  'inbox_messages',
];

/** Tables and functions of the public schema: what the migrations create. */
async function schemaObjects(): Promise<string[]> {
  const rows: { name: string }[] = await sql`
    select table_name::text as name from information_schema.tables
     where table_schema = 'public' and table_name <> 'mikro_orm_migrations'
    union all
    select routine_name::text from information_schema.routines where routine_schema = 'public'
  `;
  return rows.map((row) => row.name).sort();
}

describe('migrations by script', () => {
  test('down drops everything they created and up recreates it', async () => {
    const created = await schemaObjects();
    expect(created).toEqual(expect.arrayContaining(TABLES));

    const reverted = await orm.migrator.down({ to: 0 });

    expect(reverted.map((migration) => migration.name)).toEqual([...ALL_MIGRATIONS].reverse());
    expect(await schemaObjects()).toEqual([]);

    const applied = await orm.migrator.up();

    expect(applied.map((migration) => migration.name)).toEqual(ALL_MIGRATIONS);
    expect(await schemaObjects()).toEqual(created);
  });

  test('the migrate script goes down and back up', async () => {
    const runScript = async (direction: string): Promise<unknown> => {
      const child = Bun.spawn([process.execPath, 'src/database/migrate.ts', direction], {
        env: { ...process.env, DATABASE_URL: loadConfig().databaseUrl },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
      expect(exitCode).toBe(0);
      return JSON.parse(stdout.trim().split('\n').at(-1)!);
    };

    expect(await runScript('down')).toEqual({ direction: 'down', migrations: [...ALL_MIGRATIONS].reverse() });
    for (const table of TABLES) expect(await tableExists(table)).toBe(false);
    expect(await runScript('up')).toEqual({ direction: 'up', migrations: ALL_MIGRATIONS });
    for (const table of TABLES) expect(await tableExists(table)).toBe(true);
  });
});

describe('wallet mapping', () => {
  test('a persisted wallet loads back as a Wallet with an exact Money balance', async () => {
    const wallet = Wallet.open({
      id: Bun.randomUUIDv7(),
      playerId: Bun.randomUUIDv7(),
      initialBalance: Money.zero('BRL'),
    });
    await orm.em.fork().persist(wallet).flush();

    const loaded = await orm.em.fork().findOneOrFail(Wallet, wallet.id);

    expect(loaded).toBeInstanceOf(Wallet);
    expect(loaded.balance).toBeInstanceOf(Money);
    expect(loaded.balance.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(loaded.playerId).toBe(wallet.playerId);
    expect(loaded.currency).toBe('BRL');
    expect(loaded.version).toBe(1);
    expect(loaded.createdAt.getTime()).toBe(wallet.createdAt.getTime());
    expect(loaded.updatedAt.getTime()).toBe(wallet.updatedAt.getTime());
  });

  test('the initial balance and the creation key and hash load back as persisted', async () => {
    const creation = { idempotencyKey: Bun.randomUUIDv7(), payloadHash: 'e'.repeat(64) };
    const wallet = Wallet.open({
      id: Bun.randomUUIDv7(),
      playerId: Bun.randomUUIDv7(),
      initialBalance: Money.zero('USD'),
      creation,
    });
    await orm.em.fork().persist(wallet).flush();

    const loaded = await orm.em.fork().findOneOrFail(Wallet, { creationIdempotencyKey: creation.idempotencyKey });

    expect(loaded.id).toBe(wallet.id);
    expect(loaded.initialBalance).toBeInstanceOf(Money);
    expect(loaded.initialBalance.toJSON()).toEqual({ amount: '0.00', currency: 'USD' });
    expect(loaded.creationPayloadHash).toBe(creation.payloadHash);
  });

  test('a wallet created without a key loads back with no key and no hash', async () => {
    const wallet = Wallet.open({ id: Bun.randomUUIDv7(), playerId: Bun.randomUUIDv7(), initialBalance: Money.zero('BRL') });
    await orm.em.fork().persist(wallet).flush();

    const loaded = await orm.em.fork().findOneOrFail(Wallet, wallet.id);

    expect(loaded.creationIdempotencyKey).toBeUndefined();
    expect(loaded.creationPayloadHash).toBeUndefined();
  });

  test('queries filter by the public name of a private field', async () => {
    const wallet = Wallet.open({
      id: Bun.randomUUIDv7(),
      playerId: Bun.randomUUIDv7(),
      initialBalance: Money.zero('USD'),
    });
    await orm.em.fork().persist(wallet).flush();

    const found = await orm.em.fork().findOne(Wallet, { id: wallet.id, version: 1 });

    expect(found?.id).toBe(wallet.id);
  });
});

describe('schema invariants, by raw SQL', () => {
  test('the balance CHECK refuses a negative balance', async () => {
    const id = await insertWallet();

    const update = sql`update wallets set balance_amount = -0.01 where id = ${id}`;

    await expect(update).rejects.toThrow(/wallets_balance_non_negative/);
  });

  test('the version CHECK refuses a version below 1', async () => {
    await expect(insertWallet({ version: 0 })).rejects.toThrow(/wallets_version_positive/);
  });

  test('the currency CHECK ties the wallet currency to the balance currency', async () => {
    await expect(insertWallet({ balance_currency: 'USD' })).rejects.toThrow(
      /wallets_balance_currency_matches/,
    );
  });

  test('the creation key and hash are both absent or both present', async () => {
    await expect(insertWallet({ creation_idempotency_key: Bun.randomUUIDv7() })).rejects.toThrow(
      /wallets_creation_key_and_hash_together/,
    );
    await expect(insertWallet({ creation_payload_hash: 'a'.repeat(64) })).rejects.toThrow(
      /wallets_creation_key_and_hash_together/,
    );
  });

  test('a creation key belongs to one wallet only', async () => {
    const key = Bun.randomUUIDv7();
    await insertWallet({ creation_idempotency_key: key, creation_payload_hash: 'a'.repeat(64) });

    await expect(insertWallet({ creation_idempotency_key: key, creation_payload_hash: 'a'.repeat(64) })).rejects.toThrow(
      /wallets_creation_idempotency_key_unique/,
    );
  });

  test('the initial balance and the creation key and hash never change', async () => {
    const id = await insertWallet({ creation_idempotency_key: Bun.randomUUIDv7(), creation_payload_hash: 'a'.repeat(64) });

    for (const change of [
      sql`update wallets set initial_balance_amount = 1.00 where id = ${id}`,
      sql`update wallets set creation_idempotency_key = ${Bun.randomUUIDv7()} where id = ${id}`,
      sql`update wallets set creation_idempotency_key = null, creation_payload_hash = null where id = ${id}`,
      sql`update wallets set creation_payload_hash = ${'b'.repeat(64)} where id = ${id}`,
    ]) {
      await expect(change).rejects.toThrow(/wallets_identity_immutable/);
    }
  });

  test('a player has at most one wallet per currency', async () => {
    const playerId = Bun.randomUUIDv7();
    await insertWallet({ player_id: playerId });

    await expect(insertWallet({ player_id: playerId })).rejects.toThrow(/wallets_player_currency_unique/);
    expect(await insertWallet({ player_id: playerId, currency: 'USD', balance_currency: 'USD' })).toBeString();
  });

  test('(id, currency) is unique, so the ledger can pin its currency to the wallet by FK', async () => {
    const id = await insertWallet();
    // PostgreSQL forbids a temporary table referencing a regular one, so the probe
    // is a regular table, dropped at the end.
    await sql`create table currency_pin_probe (
      wallet_id uuid not null,
      currency char(3) not null,
      foreign key (wallet_id, currency) references wallets (id, currency)
    )`;
    try {
      await sql`insert into currency_pin_probe values (${id}, 'BRL')`;
      const wrongCurrency = sql`insert into currency_pin_probe values (${id}, 'USD')`;

      await expect(wrongCurrency).rejects.toThrow(/foreign key/);
    } finally {
      await sql`drop table currency_pin_probe`;
    }
  });
});

describe('opening mapping', () => {
  test('a wallet, its OPENING and its entry flush together and load back as domain objects', async () => {
    const initialBalance = Money.from({ amount: '250.75', currency: 'BRL' });
    const wallet = Wallet.open({ id: Bun.randomUUIDv7(), playerId: Bun.randomUUIDv7(), initialBalance });
    const opening = WagerTransaction.create({
      id: Bun.randomUUIDv7(),
      providerId: 'internal',
      externalTransactionId: `opening:${wallet.id}`,
      idempotencyKey: `opening:${wallet.id}`,
      payloadHash: 'f'.repeat(64),
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'opening',
      gameId: 'opening',
      kind: WagerTransactionKind.Opening,
      money: initialBalance,
      correlationId: 'corr-mapping',
    });
    opening.markProcessed({ at: wallet.createdAt, balanceAfter: wallet.balance, walletVersionObserved: 1 });
    const entry = wallet.openingEntry({ entryId: Bun.randomUUIDv7(), transactionId: opening.id });

    // Persisted entry first: the flush must order the inserts by their foreign keys.
    await orm.em.fork().persist(entry).persist(opening).persist(wallet).flush();

    const em = orm.em.fork();
    const loadedOpening = await em.findOneOrFail(WagerTransaction, opening.id);
    expect(loadedOpening).toBeInstanceOf(WagerTransaction);
    expect(loadedOpening.status).toBe(WagerTransactionStatus.Processed);
    expect(loadedOpening.kind).toBe(WagerTransactionKind.Opening);
    expect(loadedOpening.money.toJSON()).toEqual(initialBalance.toJSON());
    expect(loadedOpening.balanceAfter?.toJSON()).toEqual(initialBalance.toJSON());
    expect(loadedOpening.walletVersionObserved).toBe(1);
    expect(loadedOpening.processedAt?.getTime()).toBe(wallet.createdAt.getTime());
    expect(loadedOpening.referenceExternalTransactionId).toBeUndefined();
    expect(loadedOpening.referenceTransactionId).toBeUndefined();
    expect(loadedOpening.failureCode).toBeUndefined();
    expect(loadedOpening.correlationId).toBe('corr-mapping');
    expect(loadedOpening.walletId).toBe(wallet.id);

    const loadedWallet = await em.findOneOrFail(Wallet, wallet.id);
    expect(loadedWallet.initialBalance.toJSON()).toEqual(initialBalance.toJSON());

    const [loadedEntry] = await em.find(WalletLedgerEntry, { walletId: wallet.id });
    expect(loadedEntry).toBeInstanceOf(WalletLedgerEntry);
    expect(loadedEntry!.transactionId).toBe(opening.id);
    expect(loadedEntry!.direction).toBe(LedgerDirection.Credit);
    expect(loadedEntry!.balanceBefore.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(loadedEntry!.balanceAfter.toJSON()).toEqual(initialBalance.toJSON());
    expect(loadedEntry!.walletVersion).toBe(1);
    expect(loadedEntry!.isBalanced()).toBe(true);

    await expectLedgerConsistent(sql, [wallet.id]);
  });
});
