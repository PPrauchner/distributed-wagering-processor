/**
 * The first domain checks of every provider transaction against its wallet,
 * in the documented order — player, then currency (`ARCHITECTURE.md` § Ordem
 * das validações, step 8).
 *
 * @packageDocumentation
 */
import { FailureCode } from '../../shared/domain/failure-code.ts';
import type { Wallet } from '../../wallet/domain/wallet.ts';
import type { WagerTransaction } from './wager-transaction.ts';

/**
 * @param transaction - The transaction being settled.
 * @param wallet - Its wallet, read under lock.
 * @returns `WALLET_PLAYER_MISMATCH` or `CURRENCY_MISMATCH`, the first that
 *   applies, or `undefined` when the transaction fits its wallet.
 */
export function walletRejectionOf(transaction: WagerTransaction, wallet: Wallet): FailureCode | undefined {
  if (transaction.playerId !== wallet.playerId) return FailureCode.WalletPlayerMismatch;
  if (transaction.money.currency !== wallet.currency) return FailureCode.CurrencyMismatch;
  return undefined;
}

/**
 * Rejects a transaction leaving its wallet untouched, recording the balance and
 * version observed under lock.
 *
 * @param transaction - The transaction, still `PENDING`.
 * @param wallet - Its wallet, read under lock.
 * @param rejection - The failure code, and the message when the code alone is not enough.
 */
export function rejectOn(
  transaction: WagerTransaction,
  wallet: Wallet,
  rejection: { code: FailureCode; message?: string },
): void {
  transaction.reject({
    ...rejection,
    balanceAfter: wallet.balance,
    walletVersionObserved: wallet.version,
  });
}
