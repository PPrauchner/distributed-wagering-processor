/**
 * `Reconciliation` over the real unit of work and PostgreSQL, against
 * divergences provoked by raw SQL: the test session alone turns the triggers
 * off (`session_replication_role = replica`, local to its own SQL transaction),
 * so no trigger, constraint or permission of the schema is loosened. A
 * divergence is reported, logged and counted, and nothing is changed.
 *
 * @packageDocumentation
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../../../src/config.ts';
import { createOrmConfig } from '../../../src/database/orm.config.ts';
import { MikroOrmUnitOfWork } from '../../../src/database/mikro-orm-unit-of-work.ts';
import { CreateWallet } from '../../../src/wallet/application/create-wallet.ts';
import {
  InMemoryReconciliationDivergenceCounter,
  Reconciliation,
  type ReconciliationLog,
} from '../../../src/wallet/application/reconciliation.ts';
import { expectLedgerConsistent } from '../ledger-invariant.ts';

let orm: MikroORM;
let sql: SQL;
let createWallet: CreateWallet;
let unitOfWork: MikroOrmUnitOfWork;
const touchedWallets: string[] = [];

beforeAll(async () => {
  const { databaseUrl } = loadConfig();
  orm = await MikroORM.init(createOrmConfig(databaseUrl));
  sql = new SQL(databaseUrl);
  unitOfWork = new MikroOrmUnitOfWork(orm.em);
  createWallet = new CreateWallet(unitOfWork, () => Bun.randomUUIDv7());
});

afterAll(async () => {
  await expectLedgerConsistent(sql, touchedWallets);
  await orm?.close(true);
  await sql?.close();
});

function reconciliationWithSpies(): {
  reconciliation: Reconciliation;
  divergences: InMemoryReconciliationDivergenceCounter;
  errors: string[];
} {
  const divergences = new InMemoryReconciliationDivergenceCounter();
  const errors: string[] = [];
  const log: ReconciliationLog = { error: (message) => errors.push(message) };
  return { reconciliation: new Reconciliation(unitOfWork, divergences, log), divergences, errors };
}

async function walletWith(amount: string): Promise<string> {
  const { wallet } = await createWallet.execute({ playerId: Bun.randomUUIDv7(), initialBalance: { amount, currency: 'BRL' } });
  return wallet.id;
}

/** Runs `tamper` with every trigger off, in this session's transaction only. */
async function bypassingTriggers(tamper: (tx: SQL) => Promise<unknown>): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tamper(tx);
  });
}

async function stateOf(walletId: string): Promise<unknown> {
  const [wallet] = await sql`select * from wallets where id = ${walletId}`;
  const entries = await sql`select * from wallet_ledger_entries where wallet_id = ${walletId} order by wallet_version`;
  return { wallet, entries };
}

describe('Reconciliation', () => {
  test('a consistent wallet: no log, nothing counted', async () => {
    const walletId = await walletWith('50.00');
    touchedWallets.push(walletId);
    const { reconciliation, divergences, errors } = reconciliationWithSpies();

    const report = await reconciliation.execute(walletId);

    expect(report.consistent).toBe(true);
    expect(report.difference.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(errors).toEqual([]);
    expect(divergences.count).toBe(0);
  });

  test('a balance changed without an entry: the difference shows it, logged and counted, nothing changed', async () => {
    const walletId = await walletWith('100.00');
    await bypassingTriggers((tx) => tx`update wallets set balance_amount = 90.00 where id = ${walletId}`);
    const before = await stateOf(walletId);
    const { reconciliation, divergences, errors } = reconciliationWithSpies();

    const report = await reconciliation.execute(walletId);

    expect(report.consistent).toBe(false);
    expect(report.storedBalance.toJSON()).toEqual({ amount: '90.00', currency: 'BRL' });
    expect(report.calculatedBalance.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(report.difference.toJSON()).toEqual({ amount: '-10.00', currency: 'BRL' });
    expect(report.versionGaps).toEqual([]);
    expect(report.checkedEntries).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(walletId);
    expect(errors[0]).not.toContain('90.00');
    expect(divergences.count).toBe(1);
    expect(await stateOf(walletId)).toEqual(before);
  });

  test('gaps in the version sequence, inside and at its end: listed as ranges, logged and counted', async () => {
    const walletId = await walletWith('100.00');
    // Version 3 credits 10.00 on top of the opening; 2, 4 and 5 have no entry.
    await bypassingTriggers(async (tx) => {
      await tx`update wallets set balance_amount = 110.00, version = 5 where id = ${walletId}`;
      await tx`
        insert into wallet_ledger_entries (
          id, wallet_id, transaction_id, direction, amount, currency,
          balance_before_amount, balance_before_currency, balance_after_amount, balance_after_currency,
          wallet_version, created_at
        ) values (
          ${Bun.randomUUIDv7()}, ${walletId}, ${Bun.randomUUIDv7()}, 'CREDIT', 10.00, 'BRL',
          100.00, 'BRL', 110.00, 'BRL', 3, now()
        )
      `;
    });
    const before = await stateOf(walletId);
    const { reconciliation, divergences, errors } = reconciliationWithSpies();

    const report = await reconciliation.execute(walletId);

    expect(report.consistent).toBe(false);
    expect(report.difference.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(report.versionGaps).toEqual([
      { from: 2, to: 2 },
      { from: 4, to: 5 },
    ]);
    expect(report.checkedEntries).toBe(2);
    expect(errors).toHaveLength(1);
    expect(divergences.count).toBe(1);
    expect(await stateOf(walletId)).toEqual(before);
  });

  test('an entry above the wallet version: reported, logged and counted', async () => {
    const walletId = await walletWith('100.00');
    // Version 2 credits 10.00 on top of the opening, but the wallet stays at version 1.
    await bypassingTriggers(async (tx) => {
      await tx`update wallets set balance_amount = 110.00 where id = ${walletId}`;
      await tx`
        insert into wallet_ledger_entries (
          id, wallet_id, transaction_id, direction, amount, currency,
          balance_before_amount, balance_before_currency, balance_after_amount, balance_after_currency,
          wallet_version, created_at
        ) values (
          ${Bun.randomUUIDv7()}, ${walletId}, ${Bun.randomUUIDv7()}, 'CREDIT', 10.00, 'BRL',
          100.00, 'BRL', 110.00, 'BRL', 2, now()
        )
      `;
    });
    const before = await stateOf(walletId);
    const { reconciliation, divergences, errors } = reconciliationWithSpies();

    const report = await reconciliation.execute(walletId);

    expect(report.consistent).toBe(false);
    expect(report.difference.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(report.versionGaps).toEqual([]);
    expect(report.walletVersion).toBe(1);
    expect(report.lastEntryVersion).toBe(2);
    expect(errors).toHaveLength(1);
    expect(divergences.count).toBe(1);
    expect(await stateOf(walletId)).toEqual(before);
  });

  test('a missing opening is a difference, not a gap', async () => {
    const walletId = await walletWith('0.00');
    await bypassingTriggers((tx) => tx`update wallets set balance_amount = 20.00 where id = ${walletId}`);
    const { reconciliation } = reconciliationWithSpies();

    const report = await reconciliation.execute(walletId);

    expect(report.consistent).toBe(false);
    expect(report.difference.toJSON()).toEqual({ amount: '20.00', currency: 'BRL' });
    expect(report.versionGaps).toEqual([]);
    expect(report.checkedEntries).toBe(0);
  });
});
