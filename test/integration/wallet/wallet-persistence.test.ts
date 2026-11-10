/**
 * Wallet persistence against a real PostgreSQL: reversible migrations, the
 * `defineEntity` mapping with `Money` as an embeddable, and the schema
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
  const row = {
    id: Bun.randomUUIDv7(),
    player_id: Bun.randomUUIDv7(),
    currency: 'BRL',
    balance_amount: '0.00',
    balance_currency: 'BRL',
    version: 1,
    ...overrides,
  };
  await sql`
    insert into wallets (id, player_id, currency, balance_amount, balance_currency, version, created_at, updated_at)
    values (${row.id}, ${row.player_id}, ${row.currency}, ${row.balance_amount}, ${row.balance_currency}, ${row.version}, now(), now())
  `;
  return row.id as string;
}

describe('migrations by script', () => {
  test('down drops the wallets table and up recreates it', async () => {
    await orm.migrator.down({ to: 0 });
    expect(await tableExists('wallets')).toBe(false);

    const applied = await orm.migrator.up();

    expect(applied.map((migration) => migration.name)).toEqual(['Migration0001Wallets']);
    expect(await tableExists('wallets')).toBe(true);
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

    expect(await runScript('down')).toEqual({ direction: 'down', migrations: ['Migration0001Wallets'] });
    expect(await tableExists('wallets')).toBe(false);
    expect(await runScript('up')).toEqual({ direction: 'up', migrations: ['Migration0001Wallets'] });
    expect(await tableExists('wallets')).toBe(true);
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
