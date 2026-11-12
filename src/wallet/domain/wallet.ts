/**
 * `Wallet` aggregate root: a player's balance in one currency.
 *
 * @packageDocumentation
 */
import { CurrencyMismatchError, Money } from '../../shared/domain/money.ts';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry.ts';

/**
 * How a creation with an `Idempotency-Key` is recognized again: the key and the
 * hash of the creation payload.
 */
export interface WalletCreation {
  idempotencyKey: string;
  payloadHash: string;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  /** Present when the creation came with an `Idempotency-Key`. */
  creation?: WalletCreation;
}

/** Persisted state of a wallet, rebuilt as is by {@link Wallet.rehydrate}. */
export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  initialBalance: Money;
  creationIdempotencyKey?: string;
  creationPayloadHash?: string;
}

/** A credit or debit: its amount, and ids of the new entry and of its transaction. */
export interface MovementProps {
  money: Money;
  entryId: string;
  transactionId: string;
}

/** Raised when a wallet would be opened breaking one of its invariants. */
export class InvalidWalletError extends Error {
  override readonly name = 'InvalidWalletError';
}

/** Raised when a credit would take the balance past {@link MAX_BALANCE}. */
export class BalanceLimitExceededError extends Error {
  override readonly name = 'BalanceLimitExceededError';
}

const MAX_PLAYER_ID_LENGTH = 255;

/**
 * The maximum balance (`CONTEXT.md` § Saldo máximo), in any currency: the
 * limit of the `numeric(19,2)` column. A credit past it is refused, never
 * truncated.
 */
export const MAX_BALANCE = '99999999999999999.99';

/** Every wallet is opened at this version (ADR 0003). */
export const OPENING_VERSION = 1;

export class Wallet {
  // Only assigns parameters, with no validation or field initializers: the ORM's
  // metadata discovery calls `new Wallet()` with no arguments (ADR 0001).
  private constructor(
    readonly id: string,
    readonly playerId: string,
    readonly currency: string,
    private _balance: Money,
    private _version: number,
    readonly createdAt: Date,
    private _updatedAt: Date,
    /** The balance the wallet was opened with; it never changes. */
    readonly initialBalance: Money,
    readonly creationIdempotencyKey: string | undefined,
    readonly creationPayloadHash: string | undefined,
  ) {}

  /**
   * Opens a new wallet at version 1, in the currency of its initial balance.
   *
   * @param props - Wallet id, player id and initial balance.
   * @returns The new wallet.
   * @throws {@link InvalidWalletError} If the balance is negative or the player
   *   id is empty or longer than 255 characters.
   */
  static open(props: OpenWalletProps): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new InvalidWalletError('initial balance cannot be negative');
    }
    if (props.playerId.length === 0 || props.playerId.length > MAX_PLAYER_ID_LENGTH) {
      throw new InvalidWalletError(
        `playerId must have between 1 and ${MAX_PLAYER_ID_LENGTH} characters`,
      );
    }
    const now = new Date();
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      OPENING_VERSION,
      now,
      now,
      props.initialBalance,
      props.creation?.idempotencyKey,
      props.creation?.payloadHash,
    );
  }

  /** Rebuilds persisted state; does not re-run the opening rules. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
      state.initialBalance,
      state.creationIdempotencyKey,
      state.creationPayloadHash,
    );
  }

  /**
   * The ledger entry of the opening: a credit from zero to the initial balance,
   * at version 1. A wallet opened at zero has no opening (ADR 0003).
   *
   * @param ids - Id of the new entry and of the `OPENING` transaction.
   * @returns The entry; it changes nothing on the wallet.
   * @throws {@link InvalidWalletError} If the wallet is not at version 1 or its
   *   balance is zero.
   */
  openingEntry(ids: { entryId: string; transactionId: string }): WalletLedgerEntry {
    if (this._version !== OPENING_VERSION || this._balance.isZero()) {
      throw new InvalidWalletError('only a wallet opened with a positive balance has an opening');
    }
    return WalletLedgerEntry.create({
      id: ids.entryId,
      walletId: this.id,
      transactionId: ids.transactionId,
      direction: LedgerDirection.Credit,
      money: this._balance,
      balanceBefore: Money.zero(this.currency),
      balanceAfter: this._balance,
      walletVersion: this._version,
      createdAt: this.createdAt,
    });
  }

  /**
   * Credits the wallet: the balance grows, the version goes up by exactly 1, and
   * the matching ledger entry is returned for the caller to persist with it.
   *
   * @param props - Amount, and ids of the new entry and of its transaction.
   * @returns The ledger entry of this credit.
   * @throws {@link CurrencyMismatchError} If the amount is in another currency.
   * @throws {@link InvalidLedgerEntryError} If the amount is not positive.
   * @throws {@link BalanceLimitExceededError} If the balance would pass the
   *   maximum — check {@link Wallet.canCredit} first.
   */
  credit(props: MovementProps): WalletLedgerEntry {
    this.assertSameCurrency(props.money);
    if (!this.canCredit(props.money)) {
      throw new BalanceLimitExceededError(`crediting ${props.money} would take wallet ${this.id} past the maximum balance`);
    }
    return this.move(LedgerDirection.Credit, props, this._balance.add(props.money));
  }

  /**
   * Debits the wallet: the balance shrinks, the version goes up by exactly 1,
   * and the matching ledger entry is returned for the caller to persist with it.
   *
   * @param props - Amount, and ids of the new entry and of its transaction.
   * @returns The ledger entry of this debit.
   * @throws {@link CurrencyMismatchError} If the amount is in another currency.
   * @throws {@link InvalidLedgerEntryError} If the amount is not positive or
   *   exceeds the balance — check {@link Wallet.canDebit} first.
   */
  debit(props: MovementProps): WalletLedgerEntry {
    this.assertSameCurrency(props.money);
    return this.move(LedgerDirection.Debit, props, this._balance.subtract(props.money));
  }

  /**
   * @param money - An amount in the wallet's currency.
   * @returns Whether debiting it keeps the balance at zero or more.
   * @throws {@link CurrencyMismatchError} If the amount is in another currency.
   */
  canDebit(money: Money): boolean {
    return !this._balance.isLessThan(money);
  }

  /**
   * @param money - An amount in the wallet's currency.
   * @returns Whether crediting it keeps the balance at {@link MAX_BALANCE} or less.
   * @throws {@link CurrencyMismatchError} If the amount is in another currency.
   */
  canCredit(money: Money): boolean {
    const maximum = Money.fromPersisted({ amount: MAX_BALANCE, currency: this.currency });
    return !maximum.isLessThan(this._balance.add(money));
  }

  /** @throws {@link CurrencyMismatchError} If the amount is not in the wallet's currency. */
  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(`wallet ${this.id} is in ${this.currency}, not ${money.currency}`);
    }
  }

  private move(direction: LedgerDirection, props: MovementProps, balanceAfter: Money): WalletLedgerEntry {
    const at = new Date();
    const entry = WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction,
      money: props.money,
      balanceBefore: this._balance,
      balanceAfter,
      walletVersion: this._version + 1,
      createdAt: at,
    });
    this._balance = entry.balanceAfter;
    this._version = entry.walletVersion;
    this._updatedAt = at;
    return entry;
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }
}
