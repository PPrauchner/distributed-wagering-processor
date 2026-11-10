/**
 * `Wallet` aggregate root: a player's balance in one currency.
 *
 * @packageDocumentation
 */
import type { Money } from '../../shared/domain/money.ts';

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
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
}

/** Raised when a wallet would be opened breaking one of its invariants. */
export class InvalidWalletError extends Error {
  override readonly name = 'InvalidWalletError';
}

const MAX_PLAYER_ID_LENGTH = 255;

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
      1,
      now,
      now,
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
    );
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
