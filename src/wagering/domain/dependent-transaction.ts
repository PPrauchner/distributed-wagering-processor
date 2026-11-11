/**
 * The rules of a dependent transaction (`CONTEXT.md` § Transação dependente):
 * the `REFUND` returns a processed bet's amount; the `ROLLBACK` applies the
 * inverse of a processed bet, win or refund. Either undoes its reference once,
 * by any kind, and only for its whole amount (`ARCHITECTURE.md` § Reembolso e
 * reversão). The checks run in the documented order — wallet, reference,
 * amount, already undone, funds or maximum balance — and the first violation decides
 * (`ARCHITECTURE.md` § Ordem das validações, step 8).
 *
 * @packageDocumentation
 */
import { FailureCode } from '../../shared/domain/failure-code.ts';
import type { Wallet } from '../../wallet/domain/wallet.ts';
import type { WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry.ts';
import { resolveReference, waitForReference } from './reference.ts';
import { WagerTransactionKind, type WagerTransaction } from './wager-transaction.ts';
import { rejectOn, walletRejectionOf } from './wallet-coherence.ts';

/** The transaction a dependent transaction cites, as read under the wallet lock. */
export interface CitedReference {
  transaction: WagerTransaction;
  /** Whether a `REFUND` or `ROLLBACK` already `PROCESSED` undid it. */
  alreadyReversed: boolean;
}

const ACCEPTED_REFERENCE_KINDS = new Map<WagerTransactionKind, ReadonlySet<WagerTransactionKind>>([
  [WagerTransactionKind.Refund, new Set([WagerTransactionKind.Bet])],
  [
    WagerTransactionKind.Rollback,
    new Set([WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund]),
  ],
]);

// Undoing a debit credits it back; undoing a credit debits it.
const DEBITING_REFERENCE_KINDS: ReadonlySet<WagerTransactionKind> = new Set([
  WagerTransactionKind.Win,
  WagerTransactionKind.Refund,
]);

/**
 * Settles a `PENDING` refund or rollback on its wallet: processed with the
 * inverse of its reference; rejected with the wallet untouched; or, citing a
 * reference that is not there yet, left `PENDING_REFERENCE` with nothing
 * observed.
 *
 * @param transaction - The refund or rollback, `PENDING` or still waiting for
 *   its reference.
 * @param wallet - Its wallet, read under lock.
 * @param reference - The transaction it cites, found by its provider and the
 *   cited external id, and whether it was already undone; `undefined` when
 *   none was found.
 * @param ids - Id of the ledger entry the movement would write.
 * @returns The entry to persist with the wallet — `CREDIT` for a refund or the
 *   rollback of a bet, `DEBIT` for the rollback of a win or a refund — or
 *   `undefined` when the transaction is rejected or waits.
 * @throws {@link Error} If the transaction is neither a `REFUND` nor a `ROLLBACK`.
 * @throws {@link InvalidTransactionStateError} If the transaction is terminal.
 */
export function applyDependentTransaction(
  transaction: WagerTransaction,
  wallet: Wallet,
  reference: CitedReference | undefined,
  ids: { entryId: string },
): WalletLedgerEntry | undefined {
  const acceptedKinds = ACCEPTED_REFERENCE_KINDS.get(transaction.kind);
  if (acceptedKinds === undefined) {
    throw new Error(`applyDependentTransaction takes a REFUND or a ROLLBACK, got ${transaction.kind}`);
  }
  const walletRejection = walletRejectionOf(transaction, wallet);
  if (walletRejection !== undefined) {
    rejectOn(transaction, wallet, { code: walletRejection });
    return undefined;
  }
  const resolution = resolveReference(transaction, reference?.transaction, acceptedKinds);
  if (resolution.outcome === 'wait') {
    waitForReference(transaction);
    return undefined;
  }
  if (resolution.outcome === 'rejected') {
    rejectOn(transaction, wallet, resolution);
    return undefined;
  }
  const resolved = resolution.reference;
  const debits = transaction.kind === WagerTransactionKind.Rollback && DEBITING_REFERENCE_KINDS.has(resolved.kind);
  const alreadyReversed = reference?.alreadyReversed ?? false;
  const rejection = rejectionOf(transaction, wallet, { resolved, alreadyReversed, debits });
  if (rejection !== undefined) {
    rejectOn(transaction, wallet, { code: rejection });
    return undefined;
  }
  const movement = { money: transaction.money, entryId: ids.entryId, transactionId: transaction.id };
  const entry = debits ? wallet.debit(movement) : wallet.credit(movement);
  transaction.markProcessed({
    at: entry.createdAt,
    balanceAfter: wallet.balance,
    walletVersionObserved: wallet.version,
    referenceTransactionId: resolved.id,
  });
  return entry;
}

/** The rules a dependent transaction adds on top of a resolved reference. */
function rejectionOf(
  transaction: WagerTransaction,
  wallet: Wallet,
  { resolved, alreadyReversed, debits }: { resolved: WagerTransaction; alreadyReversed: boolean; debits: boolean },
): FailureCode | undefined {
  // Partial undoing does not exist.
  if (!transaction.money.equals(resolved.money)) return FailureCode.ReferenceAmountMismatch;
  if (alreadyReversed) return FailureCode.ReferenceAlreadyReversed;
  if (debits && !wallet.canDebit(transaction.money)) return FailureCode.ReversalInsufficientFunds;
  if (!debits && !wallet.canCredit(transaction.money)) return FailureCode.BalanceLimitExceeded;
  return undefined;
}
