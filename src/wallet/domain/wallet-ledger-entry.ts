/**
 * `WalletLedgerEntry`: an immutable debit or credit on a wallet, with the
 * balance before and after it and the wallet version it produced (ADR 0003).
 * Structurally immutable — no mutable field and no transition method.
 *
 * @packageDocumentation
 */
import type { Money } from '../../shared/domain/money.ts';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

/** Everything an entry holds; also its persisted state. */
export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  /** The wallet version after this entry. */
  walletVersion: number;
  createdAt: Date;
}

export type LedgerEntryState = CreateLedgerEntryProps;

/** Raised when an entry would break its arithmetic or its sequence. */
export class InvalidLedgerEntryError extends Error {
  override readonly name = 'InvalidLedgerEntryError';
}

export class WalletLedgerEntry {
  // Only assigns parameters: the ORM's metadata discovery calls the constructor
  // with no arguments (ADR 0001), so validation lives in `create`.
  private constructor(
    readonly id: string,
    readonly walletId: string,
    readonly transactionId: string,
    readonly direction: LedgerDirection,
    readonly money: Money,
    readonly balanceBefore: Money,
    readonly balanceAfter: Money,
    readonly walletVersion: number,
    readonly createdAt: Date,
  ) {}

  /**
   * @param props - The entry; `balanceBefore ± money` must equal `balanceAfter`.
   * @returns The entry.
   * @throws {@link InvalidLedgerEntryError} If the amount is not positive, a
   *   balance is negative, the arithmetic does not add up, the currencies differ
   *   or the wallet version is not an integer from 1.
   */
  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const { money, balanceBefore, balanceAfter } = props;
    if (money.currency !== balanceBefore.currency || money.currency !== balanceAfter.currency) {
      throw new InvalidLedgerEntryError('amount and balances must share one currency');
    }
    if (!money.isPositive()) throw new InvalidLedgerEntryError('amount must be positive');
    if (balanceBefore.isNegative() || balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError('balances cannot be negative');
    }
    if (!Number.isInteger(props.walletVersion) || props.walletVersion < 1) {
      throw new InvalidLedgerEntryError('wallet version must be an integer from 1');
    }
    const entry = WalletLedgerEntry.rehydrate(props);
    if (!entry.isBalanced()) {
      throw new InvalidLedgerEntryError(
        `${balanceBefore} ${props.direction} ${money} does not give ${balanceAfter}`,
      );
    }
    return entry;
  }

  /** Rebuilds persisted state; does not re-check the arithmetic. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.walletVersion,
      state.createdAt,
    );
  }

  /** @returns Whether `balanceBefore ± money === balanceAfter`, by direction. */
  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }
}
