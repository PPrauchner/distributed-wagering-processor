/**
 * Creates a player's wallet in one currency. A positive initial balance is
 * credited by the opening — an internal `OPENING` transaction, already
 * `PROCESSED`, and its `WagerTransactionProcessed`, recorded through the
 * `OpeningRecorder` port; its `CREDIT` ledger entry; and the
 * `WalletBalanceChanged` event in the outbox — in the same unit of work as the
 * wallet: all of it is committed together or not at all.
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
import { TransientFailureError } from '../../shared/application/infrastructure-failures.ts';
import type { UnitOfWork } from '../../shared/application/unit-of-work.ts';
import { Money, type MoneyProps } from '../../shared/domain/money.ts';
import { WalletBalanceChanged } from '../domain/wallet-balance-changed.ts';
import type { OpeningRecorder } from './opening-recorder.ts';
import type { WalletMetrics } from './wallet-metrics.ts';
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

/**
 * @typeParam TOpeningRepositories - What the opening recorder writes to, besides
 *   the wallet's own repositories, in the same unit of work.
 */
export class CreateWallet<TOpeningRepositories = unknown> {
  constructor(
    // Inferred from the recorder: the unit of work offers at least what it writes to.
    private readonly unitOfWork: UnitOfWork<WalletRepositories & OutboxRepositories & NoInfer<TOpeningRepositories>>,
    private readonly openings: OpeningRecorder<TOpeningRepositories>,
    private readonly generateId: () => string,
    private readonly metrics: WalletMetrics,
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
   * @throws {@link TransientFailureError} If the creation waited on a lock
   *   past the lock timeout — counted — or the database was unavailable.
   */
  async execute(command: CreateWalletCommand): Promise<CreatedWallet> {
    try {
      return await this.create(command);
    } catch (error) {
      if (error instanceof TransientFailureError && error.lockConflict) this.metrics.lockConflict(error.lockConflict);
      throw error;
    }
  }

  private async create(command: CreateWalletCommand): Promise<CreatedWallet> {
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
      return await this.unitOfWork.run(async (repositories) => {
        const { wallets, ledger, outbox } = repositories;
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
          const transactionId = this.generateId();
          const entry = wallet.openingEntry({ entryId: this.generateId(), transactionId });
          this.openings.record(repositories, { transactionId, wallet, correlationId });
          ledger.add(entry);
          const context = { correlationId, causationId: transactionId };
          const changed = WalletBalanceChanged.from(wallet, entry, context, { eventId: this.generateId() });
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

  private existingWalletId(wallet: Wallet): Promise<string> {
    return this.unitOfWork.run(async ({ wallets }) => {
      const existing = await wallets.findByPlayerAndCurrency(wallet.playerId, wallet.currency);
      if (!existing) throw new Error('unique violation reported, but no wallet found');
      return existing.id;
    });
  }
}
