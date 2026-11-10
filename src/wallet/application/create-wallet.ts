/**
 * Creates a player's wallet in one currency. A positive initial balance is
 * credited by the opening — an internal `OPENING` transaction, already
 * `PROCESSED`, and its `CREDIT` ledger entry — in the same unit of work as the
 * wallet: all three are committed together or not at all.
 *
 * @packageDocumentation
 */
import { hashPayload } from '../../shared/application/payload-hash.ts';
import type { UnitOfWork } from '../../shared/application/unit-of-work.ts';
import { Money, type MoneyProps } from '../../shared/domain/money.ts';
import type { WageringRepositories } from '../../wagering/application/wager-transaction-repository.ts';
import { WagerTransaction, WagerTransactionKind } from '../../wagering/domain/wager-transaction.ts';
import { Wallet } from '../domain/wallet.ts';
import type { WalletRepositories } from './wallet-repository.ts';
import { DuplicateWalletError, WalletAlreadyExistsError } from './wallet-errors.ts';

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  /** Recorded on the opening; generated when absent. */
  correlationId?: string;
}

/** The opening is internal: it never comes from a provider. */
const OPENING_PROVIDER_ID = 'internal';
const OPENING_ROUND_AND_GAME = 'opening';

export class CreateWallet {
  constructor(
    private readonly unitOfWork: UnitOfWork<WalletRepositories & WageringRepositories>,
    private readonly generateId: () => string,
  ) {}

  /**
   * @param command - Player, initial balance (zero or more) and correlation id.
   * @returns The new wallet, at version 1.
   * @throws {@link InvalidMoneyError} If the initial balance is malformed or negative.
   * @throws {@link InvalidWalletError} If the player id is invalid.
   * @throws {@link WalletAlreadyExistsError} If the player already has a wallet in
   *   that currency — also when a simultaneous creation wins the race.
   */
  async execute(command: CreateWalletCommand): Promise<Wallet> {
    const wallet = Wallet.open({
      id: this.generateId(),
      playerId: command.playerId,
      initialBalance: Money.from(command.initialBalance),
    });
    const correlationId = command.correlationId ?? this.generateId();

    try {
      return await this.unitOfWork.run(async ({ wallets, ledger, transactions }) => {
        const existing = await wallets.findByPlayerAndCurrency(wallet.playerId, wallet.currency);
        if (existing) throw new WalletAlreadyExistsError(existing.id);
        wallets.add(wallet);
        if (!wallet.balance.isZero()) {
          const opening = this.openingOf(wallet, correlationId);
          transactions.add(opening);
          ledger.add(wallet.openingEntry({ entryId: this.generateId(), transactionId: opening.id }));
        }
        return wallet;
      });
    } catch (error) {
      if (!(error instanceof DuplicateWalletError)) throw error;
      // Lost the race to a simultaneous creation: the winner is committed now.
      throw new WalletAlreadyExistsError(await this.existingWalletId(wallet));
    }
  }

  /** The `OPENING` that credits the wallet's initial balance, already `PROCESSED`. */
  private openingOf(wallet: Wallet, correlationId: string): WagerTransaction {
    const key = `opening:${wallet.id}`;
    const opening = WagerTransaction.create({
      id: this.generateId(),
      providerId: OPENING_PROVIDER_ID,
      externalTransactionId: key,
      idempotencyKey: key,
      payloadHash: hashPayload({
        walletId: wallet.id,
        playerId: wallet.playerId,
        initialBalance: { ...wallet.balance.toJSON() },
      }),
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: OPENING_ROUND_AND_GAME,
      gameId: OPENING_ROUND_AND_GAME,
      kind: WagerTransactionKind.Opening,
      money: wallet.balance,
      correlationId,
    });
    opening.markProcessed({
      at: wallet.createdAt,
      balanceAfter: wallet.balance,
      walletVersionObserved: wallet.version,
    });
    return opening;
  }

  private existingWalletId(wallet: Wallet): Promise<string> {
    return this.unitOfWork.run(async ({ wallets }) => {
      const existing = await wallets.findByPlayerAndCurrency(wallet.playerId, wallet.currency);
      if (!existing) throw new Error('unique violation reported, but no wallet found');
      return existing.id;
    });
  }
}
