/**
 * The `LOSS` rules: the result of a round without a prize. It never moves the
 * balance nor writes a ledger entry, but records the balance and version it
 * observed under lock, so a replay answers the same balance.
 *
 * @packageDocumentation
 */
import type { Wallet } from '../../wallet/domain/wallet.ts';
import { WagerTransactionKind, type WagerTransaction } from './wager-transaction.ts';
import { rejectOn, walletRejectionOf } from './wallet-coherence.ts';

/**
 * Settles a `PENDING` loss on its wallet: processed, or rejected when it does
 * not fit the wallet. The wallet is untouched either way.
 *
 * @param transaction - The loss, still `PENDING`.
 * @param wallet - Its wallet, read under lock.
 * @throws {@link Error} If the transaction is not a `LOSS`.
 * @throws {@link InvalidTransactionStateError} If the transaction is terminal.
 */
export function applyLoss(transaction: WagerTransaction, wallet: Wallet): void {
  if (transaction.kind !== WagerTransactionKind.Loss) {
    throw new Error(`applyLoss takes a LOSS, got ${transaction.kind}`);
  }
  const rejection = walletRejectionOf(transaction, wallet);
  if (rejection !== undefined) {
    rejectOn(transaction, wallet, { code: rejection });
    return;
  }
  transaction.markProcessed({
    at: new Date(),
    balanceAfter: wallet.balance,
    walletVersionObserved: wallet.version,
  });
}
