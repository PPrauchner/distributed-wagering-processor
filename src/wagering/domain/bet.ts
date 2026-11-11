/**
 * The `BET` rules: what a bet does to the wallet it was placed on, already
 * locked by the caller. The domain checks run in the documented order —
 * player, currency, funds (`ARCHITECTURE.md` § Ordem das validações, step 8) —
 * and the first violation rejects the bet.
 *
 * @packageDocumentation
 */
import { FailureCode } from '../../shared/domain/failure-code.ts';
import type { Wallet } from '../../wallet/domain/wallet.ts';
import type { WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry.ts';
import { WagerTransactionKind, type WagerTransaction } from './wager-transaction.ts';
import { rejectOn, walletRejectionOf } from './wallet-coherence.ts';

/**
 * Settles a `PENDING` bet on its wallet: processed with a debit, or rejected
 * with the wallet untouched. Either way the transaction records the balance and
 * version it observed.
 *
 * @param transaction - The bet, still `PENDING`.
 * @param wallet - Its wallet, read under lock.
 * @param ids - Id of the ledger entry a debit would write.
 * @returns The `DEBIT` entry to persist with the wallet, or `undefined` when the
 *   bet is rejected.
 * @throws {@link Error} If the transaction is not a `BET`.
 * @throws {@link InvalidTransactionStateError} If the transaction is terminal.
 */
export function applyBet(
  transaction: WagerTransaction,
  wallet: Wallet,
  ids: { entryId: string },
): WalletLedgerEntry | undefined {
  if (transaction.kind !== WagerTransactionKind.Bet) {
    throw new Error(`applyBet takes a BET, got ${transaction.kind}`);
  }
  const rejection = rejectionOf(transaction, wallet);
  if (rejection !== undefined) {
    rejectOn(transaction, wallet, { code: rejection });
    return undefined;
  }
  const entry = wallet.debit({ money: transaction.money, entryId: ids.entryId, transactionId: transaction.id });
  transaction.markProcessed({
    at: entry.createdAt,
    balanceAfter: wallet.balance,
    walletVersionObserved: wallet.version,
  });
  return entry;
}

function rejectionOf(transaction: WagerTransaction, wallet: Wallet): FailureCode | undefined {
  const walletRejection = walletRejectionOf(transaction, wallet);
  if (walletRejection !== undefined) return walletRejection;
  if (!wallet.canDebit(transaction.money)) return FailureCode.InsufficientFunds;
  return undefined;
}
