/**
 * Wallet use cases over the real unit of work and PostgreSQL: creation — with
 * the opening when the initial balance is positive, all or nothing —,
 * duplicate detection (including the race between simultaneous creations) and
 * lookup. Ends by checking the ledger invariant of every wallet it touched.
 *
 * @packageDocumentation
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../../../src/config.ts';
import { createOrmConfig } from '../../../src/database/orm.config.ts';
import { MikroOrmUnitOfWork, type Repositories } from '../../../src/database/mikro-orm-unit-of-work.ts';
import type { UnitOfWork } from '../../../src/shared/application/unit-of-work.ts';
import { PermanentFailureError } from '../../../src/shared/application/infrastructure-failures.ts';
import { hashPayload } from '../../../src/shared/application/payload-hash.ts';
import { FailureCode } from '../../../src/shared/domain/failure-code.ts';
import { Money } from '../../../src/shared/domain/money.ts';
import { InvalidMoneyError } from '../../../src/shared/domain/money.ts';
import { Wallet } from '../../../src/wallet/domain/wallet.ts';
import { WalletLedgerEntry } from '../../../src/wallet/domain/wallet-ledger-entry.ts';
import { CreateWallet, type CreateWalletCommand, type CreatedWallet } from '../../../src/wallet/application/create-wallet.ts';
import { GetWallet } from '../../../src/wallet/application/get-wallet.ts';
import {
  DuplicateWalletError,
  WalletCreationConflictError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../../../src/wallet/application/wallet-errors.ts';
import { expectLedgerConsistent } from '../ledger-invariant.ts';

let orm: MikroORM;
let sql: SQL;
let unitOfWork: MikroOrmUnitOfWork;
let createWallet: CreateWallet;
let getWallet: GetWallet;
const touchedWallets: string[] = [];

beforeAll(async () => {
  const { databaseUrl } = loadConfig();
  orm = await MikroORM.init(createOrmConfig(databaseUrl));
  sql = new SQL(databaseUrl);
  unitOfWork = new MikroOrmUnitOfWork(orm.em);
  createWallet = new CreateWallet(unitOfWork, () => Bun.randomUUIDv7());
  getWallet = new GetWallet(unitOfWork);
});

afterAll(async () => {
  await expectLedgerConsistent(sql, touchedWallets);
  await orm?.close(true);
  await sql?.close();
});

const zeroBrl = { amount: '0.00', currency: 'BRL' };

/**
 * Forces the race READ COMMITTED leaves open: right after the attempt's lookup
 * by key finds nothing, the winner runs and commits on its own unit of work.
 *
 * @param attemptCommand - The creation that loses the race.
 * @param winnerCommand - The creation that commits in between.
 * @returns The attempt, and the winner's result once it has run.
 */
function raceAfterKeyLookup(
  attemptCommand: CreateWalletCommand,
  winnerCommand: CreateWalletCommand,
): { attempt: Promise<CreatedWallet>; winner: () => Promise<CreatedWallet> } {
  let winner: Promise<CreatedWallet> | undefined;
  const racing: UnitOfWork<Repositories> = {
    run: (work) =>
      unitOfWork.run((repositories) =>
        work({
          ...repositories,
          wallets: {
            findByPlayerAndCurrency: (...args) => repositories.wallets.findByPlayerAndCurrency(...args),
            findById: (...args) => repositories.wallets.findById(...args),
            findByIdForUpdate: (...args) => repositories.wallets.findByIdForUpdate(...args),
            add: (wallet) => repositories.wallets.add(wallet),
            findByCreationIdempotencyKey: async (key) => {
              const found = await repositories.wallets.findByCreationIdempotencyKey(key);
              if (found === null && winner === undefined) {
                winner = createWallet.execute(winnerCommand);
                await winner;
              }
              return found;
            },
          },
        }),
      ),
  };
  const attempt = new CreateWallet(racing, () => Bun.randomUUIDv7()).execute(attemptCommand);
  return {
    attempt,
    winner: () => {
      if (winner === undefined) throw new Error('the winner never ran');
      return winner;
    },
  };
}

describe('CreateWallet', () => {
  test('opens and persists a zero-balance wallet', async () => {
    const playerId = Bun.randomUUIDv7();

    const { wallet: created } = await createWallet.execute({ playerId, initialBalance: zeroBrl });

    const stored = await getWallet.execute(created.id);
    expect(stored.playerId).toBe(playerId);
    expect(stored.balance.toJSON()).toEqual(zeroBrl);
    expect(stored.version).toBe(1);
  });

  test('a second wallet for the same player and currency points at the existing one', async () => {
    const playerId = Bun.randomUUIDv7();
    const { wallet: first } = await createWallet.execute({ playerId, initialBalance: zeroBrl });

    const second = createWallet.execute({ playerId, initialBalance: zeroBrl });

    await expect(second).rejects.toBeInstanceOf(WalletAlreadyExistsError);
    await expect(second).rejects.toMatchObject({ walletId: first.id });
  });

  test('the same player may hold wallets in different currencies', async () => {
    const playerId = Bun.randomUUIDv7();
    await createWallet.execute({ playerId, initialBalance: zeroBrl });

    const { wallet: usd } = await createWallet.execute({
      playerId,
      initialBalance: { amount: '0.00', currency: 'USD' },
    });

    expect(usd.currency).toBe('USD');
  });

  test('simultaneous creations: exactly one wins, the rest point at the winner', async () => {
    const playerId = Bun.randomUUIDv7();

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => createWallet.execute({ playerId, initialBalance: zeroBrl })),
    );

    const created = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(created).toHaveLength(1);
    const winnerId = (created[0] as PromiseFulfilledResult<CreatedWallet>).value.wallet.id;
    for (const { reason } of refused) {
      expect(reason).toBeInstanceOf(WalletAlreadyExistsError);
      expect(reason.walletId).toBe(winnerId);
    }
  });

  test('a positive initial balance writes the wallet, a PROCESSED OPENING and its CREDIT entry', async () => {
    const playerId = Bun.randomUUIDv7();

    const { wallet } = await createWallet.execute({
      playerId,
      initialBalance: { amount: '1000.00', currency: 'BRL' },
      correlationId: 'corr-opening',
    });
    touchedWallets.push(wallet.id);

    expect(wallet.balance.toJSON()).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(wallet.version).toBe(1);
    const [opening] = await sql`select * from wager_transactions where wallet_id = ${wallet.id}`;
    expect(opening).toMatchObject({
      provider_id: 'internal',
      idempotency_key: `opening:${wallet.id}`,
      external_transaction_id: `opening:${wallet.id}`,
      round_id: 'opening',
      game_id: 'opening',
      player_id: playerId,
      kind: 'OPENING',
      status: 'PROCESSED',
      amount: '1000.00',
      currency: 'BRL',
      balance_after_amount: '1000.00',
      wallet_version_observed: 1,
      correlation_id: 'corr-opening',
      payload_hash: hashPayload({
        walletId: wallet.id,
        playerId,
        initialBalance: { amount: '1000.00', currency: 'BRL' },
      }),
    });
    expect(opening.processed_at).toBeInstanceOf(Date);
    const entries = await sql`select * from wallet_ledger_entries where wallet_id = ${wallet.id}`;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      transaction_id: opening.id,
      direction: 'CREDIT',
      amount: '1000.00',
      balance_before_amount: '0.00',
      balance_after_amount: '1000.00',
      wallet_version: 1,
    });
  });

  test('without a correlation id, the OPENING gets a generated one', async () => {
    const { wallet } = await createWallet.execute({
      playerId: Bun.randomUUIDv7(),
      initialBalance: { amount: '5.00', currency: 'BRL' },
    });
    touchedWallets.push(wallet.id);

    const [opening] = await sql`select correlation_id from wager_transactions where wallet_id = ${wallet.id}`;
    expect(opening.correlation_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
  });

  test('a zero initial balance has no opening and no entry', async () => {
    const { wallet } = await createWallet.execute({ playerId: Bun.randomUUIDv7(), initialBalance: zeroBrl });
    touchedWallets.push(wallet.id);

    const [row] = await sql`
      select (select count(*) from wager_transactions where wallet_id = ${wallet.id})::int as transactions,
             (select count(*) from wallet_ledger_entries where wallet_id = ${wallet.id})::int as entries
    `;
    expect(row).toEqual({ transactions: 0, entries: 0 });
  });

  test('a failure after the wallet is written and before the commit leaves nothing behind', async () => {
    const { wallet: existing } = await createWallet.execute({
      playerId: Bun.randomUUIDv7(),
      initialBalance: { amount: '1.00', currency: 'BRL' },
    });
    touchedWallets.push(existing.id);
    const [{ id: takenEntryId }] = await sql`select id from wallet_ledger_entries where wallet_id = ${existing.id}`;
    // The entry is written last; reusing a taken id makes its insert fail after
    // the wallet and the OPENING went into the same SQL transaction.
    const failingLedger: UnitOfWork<Repositories> = {
      run: (work) =>
        unitOfWork.run((repositories) =>
          work({
            ...repositories,
            ledger: {
              add: (entry) => repositories.ledger.add(WalletLedgerEntry.rehydrate({ ...entry, id: takenEntryId })),
              findPage: (...args) => repositories.ledger.findPage(...args),
              reconcile: (walletId) => repositories.ledger.reconcile(walletId),
            },
          }),
        ),
    };
    const playerId = Bun.randomUUIDv7();

    const attempt = new CreateWallet(failingLedger, () => Bun.randomUUIDv7()).execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    // The primary key of the entry is no documented constraint: unexpected.
    const error = await attempt.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PermanentFailureError);
    expect((error as PermanentFailureError).failureCode).toBe(FailureCode.InfraUnexpected);
    expect(String((error as Error).cause)).toContain('wallet_ledger_entries_pkey');
    const [row] = await sql`
      select (select count(*) from wallets where player_id = ${playerId})::int as wallets,
             (select count(*) from wager_transactions where player_id = ${playerId})::int as transactions,
             (select count(*) from wallet_ledger_entries e join wallets w on w.id = e.wallet_id
               where w.player_id = ${playerId})::int as entries
    `;
    expect(row).toEqual({ wallets: 0, transactions: 0, entries: 0 });
  });

  test('a creation with the same key that commits between the key lookup and the player lookup is replayed', async () => {
    const command = { playerId: Bun.randomUUIDv7(), initialBalance: zeroBrl, idempotencyKey: Bun.randomUUIDv7() };
    const { attempt, winner } = raceAfterKeyLookup(command, command);

    const result = await attempt;

    expect(result.idempotentReplay).toBe(true);
    expect(result.wallet.id).toBe((await winner()).wallet.id);
  });

  test('the same race with another payload under the key is a key conflict', async () => {
    const winnerCommand = { playerId: Bun.randomUUIDv7(), initialBalance: zeroBrl, idempotencyKey: Bun.randomUUIDv7() };
    const attemptCommand = { ...winnerCommand, initialBalance: { amount: '5.00', currency: 'BRL' } };
    const { attempt } = raceAfterKeyLookup(attemptCommand, winnerCommand);

    await expect(attempt).rejects.toBeInstanceOf(WalletCreationConflictError);
  });

  test('the same race won by a creation without the key points at the winner', async () => {
    const attemptCommand = { playerId: Bun.randomUUIDv7(), initialBalance: zeroBrl, idempotencyKey: Bun.randomUUIDv7() };
    const { attempt, winner } = raceAfterKeyLookup(attemptCommand, { ...attemptCommand, idempotencyKey: undefined });

    const error = await attempt.catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WalletAlreadyExistsError);
    expect((error as WalletAlreadyExistsError).walletId).toBe((await winner()).wallet.id);
  });

  test('a malformed initial balance is refused by Money', async () => {
    const attempt = createWallet.execute({
      playerId: Bun.randomUUIDv7(),
      initialBalance: { amount: '-1.00', currency: 'BRL' },
    });

    await expect(attempt).rejects.toBeInstanceOf(InvalidMoneyError);
  });
});

describe('MikroOrmUnitOfWork', () => {
  test('translates the (player, currency) unique violation into DuplicateWalletError', async () => {
    const playerId = Bun.randomUUIDv7();
    const open = (): Wallet =>
      Wallet.open({ id: Bun.randomUUIDv7(), playerId, initialBalance: Money.zero('BRL') });
    await unitOfWork.run(async ({ wallets }) => wallets.add(open()));

    const duplicate = unitOfWork.run(async ({ wallets }) => wallets.add(open()));

    await expect(duplicate).rejects.toBeInstanceOf(DuplicateWalletError);
  });
});

describe('GetWallet', () => {
  test('an unknown wallet is not found', async () => {
    await expect(getWallet.execute(Bun.randomUUIDv7())).rejects.toBeInstanceOf(WalletNotFoundError);
  });

  test('a malformed id is not found, not a database error', async () => {
    await expect(getWallet.execute('not-a-uuid')).rejects.toBeInstanceOf(WalletNotFoundError);
  });
});
