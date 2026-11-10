/**
 * Creates a player's wallet in one currency.
 *
 * @packageDocumentation
 */
import { Money, type MoneyProps } from '../../shared/domain/money.ts';
import type { UnitOfWork } from '../../shared/application/unit-of-work.ts';
import { Wallet } from '../domain/wallet.ts';
import type { WalletRepositories } from './wallet-repository.ts';
import {
  DuplicateWalletError,
  UnsupportedInitialBalanceError,
  WalletAlreadyExistsError,
} from './wallet-errors.ts';

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
}

export class CreateWallet {
  constructor(
    private readonly unitOfWork: UnitOfWork<WalletRepositories>,
    private readonly generateId: () => string,
  ) {}

  /**
   * @param command - Player and initial balance; only `"0.00"` is supported yet.
   * @returns The new wallet, at version 1.
   * @throws {@link InvalidMoneyError} If the initial balance is malformed or negative.
   * @throws {@link InvalidWalletError} If the player id is invalid.
   * @throws {@link UnsupportedInitialBalanceError} If the initial balance is positive.
   * @throws {@link WalletAlreadyExistsError} If the player already has a wallet in
   *   that currency — also when a simultaneous creation wins the race.
   */
  async execute(command: CreateWalletCommand): Promise<Wallet> {
    const initialBalance = Money.from(command.initialBalance);
    if (!initialBalance.isZero()) throw new UnsupportedInitialBalanceError();
    const wallet = Wallet.open({
      id: this.generateId(),
      playerId: command.playerId,
      initialBalance,
    });

    try {
      return await this.unitOfWork.run(async ({ wallets }) => {
        const existing = await wallets.findByPlayerAndCurrency(wallet.playerId, wallet.currency);
        if (existing) throw new WalletAlreadyExistsError(existing.id);
        wallets.add(wallet);
        return wallet;
      });
    } catch (error) {
      if (!(error instanceof DuplicateWalletError)) throw error;
      // Lost the race to a simultaneous creation: the winner is committed now.
      throw new WalletAlreadyExistsError(await this.existingWalletId(wallet));
    }
  }

  private existingWalletId(wallet: Wallet): Promise<string> {
    return this.unitOfWork.run(async ({ wallets }) => {
      const existing = await wallets.findByPlayerAndCurrency(wallet.playerId, wallet.currency);
      if (!existing) throw new Error('unique violation reported, but no wallet found');
      return existing.id;
    });
  }
}
