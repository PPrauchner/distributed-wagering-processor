/**
 * Creates a player's wallet in one currency. A positive initial balance is
 * credited by the opening — an internal `OPENING` transaction, already
 * `PROCESSED`, its `CREDIT` ledger entry, and the `WagerTransactionProcessed`
 * and `WalletBalanceChanged` events in the outbox — in the same unit of work as
 * the wallet: all of it is committed together or not at all.
 *
 * With an `Idempotency-Key`, the creation is idempotent: the same key and
 * payload replay the wallet the key created, and another payload is a conflict
 * — the key always decides before the player's existing wallet: it is read
 * first, read again when the player already has a wallet in that currency (a
 * simultaneous creation may have committed in between), and read again after
 * losing a race at the insert.
 *
 * @packageDocumentation
 */
import type { OutboxRepositories } from '../../messaging/application/outbox-repository.ts';
import { OutboxMessage } from '../../messaging/domain/outbox-message.ts';
import { hashPayload } from '../../shared/application/payload-hash.ts';
import type { UnitOfWork } from '../../shared/application/unit-of-work.ts';
import { Money, type MoneyProps } from '../../shared/domain/money.ts';
import type { WageringRepositories } from '../../wagering/application/wager-transaction-repository.ts';
import { WagerTransaction, WagerTransactionKind } from '../../wagering/domain/wager-transaction.ts';
import { WagerTransactionProcessed } from '../../wagering/domain/wager-transaction-events.ts';
import { WalletBalanceChanged } from '../domain/wallet-balance-changed.ts';
import { Wallet } from '../domain/wallet.ts';
import type { WalletRepositories, WalletRepository } from './wallet-repository.ts';
import {
  DuplicateWalletCreationKeyError,
  DuplicateWalletError,
  WalletAlreadyExistsError,
  WalletCreationConflictError,
} from './wallet-errors.ts';

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  /** Recorded on the opening; generated when absent. */
  correlationId?: string;
  /** The `Idempotency-Key`; without it, the creation is not idempotent. */
  idempotencyKey?: string;
}

/** The wallet the creation answers with, and whether it is a replay. */
export interface CreatedWallet {
  wallet: Wallet;
  /** True when the key had already created this wallet: nothing new was written. */
  idempotentReplay: boolean;
}

/**
 * The fingerprint of a creation: the validated player id and initial balance,
 * with the hash every payload uses. Headers and metadata stay out.
 */
function creationHash(playerId: string, initialBalance: Money): string {
  return hashPayload({ playerId, initialBalance: { ...initialBalance.toJSON() } });
}

/**
 * @param wallets - The repository of the current unit of work.
 * @param requested - The wallet this request would open, with its key and hash.
 * @returns The replay, when the key already created a wallet from the same
 *   payload; null when the request has no key or the key is new.
 * @throws {@link WalletCreationConflictError} If the key created a wallet from
 *   another payload.
 */
async function replayFrom(wallets: WalletRepository, requested: Wallet): Promise<CreatedWallet | null> {
  const key = requested.creationIdempotencyKey;
  if (key === undefined) return null;
  const created = await wallets.findByCreationIdempotencyKey(key);
  if (!created) return null;
  if (created.creationPayloadHash !== requested.creationPayloadHash) throw new WalletCreationConflictError(key);
  return { wallet: created, idempotentReplay: true };
}

/** The opening is internal: it never comes from a provider. */
const OPENING_PROVIDER_ID = 'internal';
const OPENING_ROUND_AND_GAME = 'opening';

export class CreateWallet {
  constructor(
    private readonly unitOfWork: UnitOfWork<WalletRepositories & WageringRepositories & OutboxRepositories>,
    private readonly generateId: () => string,
  ) {}

  /**
   * @param command - Player, initial balance (zero or more) and correlation id.
   * @returns The new wallet, at version 1 — or, on a replay, the wallet the key created.
   * @throws {@link InvalidMoneyError} If the initial balance is malformed or negative.
   * @throws {@link InvalidWalletError} If the player id is invalid.
   * @throws {@link WalletCreationConflictError} If the key already created a
   *   wallet from another payload — checked before the player's wallets.
   * @throws {@link WalletAlreadyExistsError} If the player already has a wallet in
   *   that currency that the key did not create — also when a simultaneous
   *   creation without that key wins the race.
   */
  async execute(command: CreateWalletCommand): Promise<CreatedWallet> {
    const initialBalance = Money.from(command.initialBalance);
    const wallet = Wallet.open({
      id: this.generateId(),
      playerId: command.playerId,
      initialBalance,
      creation:
        command.idempotencyKey === undefined
          ? undefined
          : { idempotencyKey: command.idempotencyKey, payloadHash: creationHash(command.playerId, initialBalance) },
    });
    const correlationId = command.correlationId ?? this.generateId();

    try {
      return await this.unitOfWork.run(async ({ wallets, ledger, transactions, outbox }) => {
        const replay = await replayFrom(wallets, wallet);
        if (replay) return replay;
        const existing = await wallets.findByPlayerAndCurrency(wallet.playerId, wallet.currency);
        if (existing) {
          // A simultaneous creation may have committed after the lookup by key:
          // read the key again, so it decides before the player's wallet does.
          const lateReplay = await replayFrom(wallets, wallet);
          if (lateReplay) return lateReplay;
          throw new WalletAlreadyExistsError(existing.id);
        }
        wallets.add(wallet);
        if (!wallet.balance.isZero()) {
          const opening = this.openingOf(wallet, correlationId);
          const entry = wallet.openingEntry({ entryId: this.generateId(), transactionId: opening.id });
          transactions.add(opening);
          ledger.add(entry);
          const context = { correlationId, causationId: opening.id };
          const processed = WagerTransactionProcessed.from(opening, context, { eventId: this.generateId() });
          const changed = WalletBalanceChanged.from(wallet, entry, context, { eventId: this.generateId() });
          outbox.add(OutboxMessage.enqueue(processed));
          outbox.add(OutboxMessage.enqueue(changed));
        }
        return { wallet, idempotentReplay: false };
      });
    } catch (error) {
      if (!(error instanceof DuplicateWalletError || error instanceof DuplicateWalletCreationKeyError)) throw error;
      // Lost the race to a simultaneous creation: the winner is committed now.
      // With a key, whichever uniqueness was hit, the key decides first.
      const replay = await this.unitOfWork.run(({ wallets }) => replayFrom(wallets, wallet));
      if (replay) return replay;
      if (error instanceof DuplicateWalletCreationKeyError) throw new Error('creation key reported taken, but no wallet found');
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
