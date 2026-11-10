/**
 * Wallet use cases over the real unit of work and PostgreSQL: creation,
 * duplicate detection (including the race between simultaneous creations) and
 * lookup.
 *
 * @packageDocumentation
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../../../src/config.ts';
import { createOrmConfig } from '../../../src/database/orm.config.ts';
import { MikroOrmUnitOfWork } from '../../../src/database/mikro-orm-unit-of-work.ts';
import { Money } from '../../../src/shared/domain/money.ts';
import { InvalidMoneyError } from '../../../src/shared/domain/money.ts';
import { Wallet } from '../../../src/wallet/domain/wallet.ts';
import { CreateWallet } from '../../../src/wallet/application/create-wallet.ts';
import { GetWallet } from '../../../src/wallet/application/get-wallet.ts';
import {
  DuplicateWalletError,
  UnsupportedInitialBalanceError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../../../src/wallet/application/wallet-errors.ts';

let orm: MikroORM;
let unitOfWork: MikroOrmUnitOfWork;
let createWallet: CreateWallet;
let getWallet: GetWallet;

beforeAll(async () => {
  orm = await MikroORM.init(createOrmConfig(loadConfig().databaseUrl));
  unitOfWork = new MikroOrmUnitOfWork(orm.em);
  createWallet = new CreateWallet(unitOfWork, () => Bun.randomUUIDv7());
  getWallet = new GetWallet(unitOfWork);
});

afterAll(async () => {
  await orm?.close(true);
});

const zeroBrl = { amount: '0.00', currency: 'BRL' };

describe('CreateWallet', () => {
  test('opens and persists a zero-balance wallet', async () => {
    const playerId = Bun.randomUUIDv7();

    const created = await createWallet.execute({ playerId, initialBalance: zeroBrl });

    const stored = await getWallet.execute(created.id);
    expect(stored.playerId).toBe(playerId);
    expect(stored.balance.toJSON()).toEqual(zeroBrl);
    expect(stored.version).toBe(1);
  });

  test('a second wallet for the same player and currency points at the existing one', async () => {
    const playerId = Bun.randomUUIDv7();
    const first = await createWallet.execute({ playerId, initialBalance: zeroBrl });

    const second = createWallet.execute({ playerId, initialBalance: zeroBrl });

    await expect(second).rejects.toBeInstanceOf(WalletAlreadyExistsError);
    await expect(second).rejects.toMatchObject({ walletId: first.id });
  });

  test('the same player may hold wallets in different currencies', async () => {
    const playerId = Bun.randomUUIDv7();
    await createWallet.execute({ playerId, initialBalance: zeroBrl });

    const usd = await createWallet.execute({
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
    const winnerId = (created[0] as PromiseFulfilledResult<Wallet>).value.id;
    for (const { reason } of refused) {
      expect(reason).toBeInstanceOf(WalletAlreadyExistsError);
      expect(reason.walletId).toBe(winnerId);
    }
  });

  test('a positive initial balance is not supported yet and creates nothing', async () => {
    const playerId = Bun.randomUUIDv7();

    const attempt = createWallet.execute({
      playerId,
      initialBalance: { amount: '10.00', currency: 'BRL' },
    });

    await expect(attempt).rejects.toBeInstanceOf(UnsupportedInitialBalanceError);
    expect(await createWallet.execute({ playerId, initialBalance: zeroBrl })).toBeInstanceOf(Wallet);
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
