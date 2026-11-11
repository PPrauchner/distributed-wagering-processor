/**
 * The `WIN` rules: a credit of a round's prize, with no reference or citing the
 * round's `BET`. Citing is not undoing: the amount is free and several wins may
 * cite the same bet (`ARCHITECTURE.md` § Reembolso e reversão, "Referência do
 * ganho"). No round state machine: a win without a bet is accepted.
 *
 * @packageDocumentation
 */
import type { Wallet } from '../../wallet/domain/wallet.ts';
import type { WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry.ts';
import { resolveReference } from './reference.ts';
import { WagerTransactionKind, type WagerTransaction } from './wager-transaction.ts';
import { rejectOn, walletRejectionOf } from './wallet-coherence.ts';

const ACCEPTED_REFERENCE_KINDS: ReadonlySet<WagerTransactionKind> = new Set([WagerTransactionKind.Bet]);

/**
 * Settles a `PENDING` win on its wallet: processed with a credit; rejected with
 * the wallet untouched; or, citing a reference that is not there yet, left
 * `PENDING_REFERENCE` with nothing observed.
 *
 * @param transaction - The win, still `PENDING`.
 * @param wallet - Its wallet, read under lock.
 * @param reference - The transaction it cites, found by its provider and the
 *   cited external id; `undefined` when it cites none or none was found.
 * @param ids - Id of the ledger entry a credit would write.
 * @returns The `CREDIT` entry to persist with the wallet, or `undefined` when
 *   the win is rejected or waits.
 * @throws {@link Error} If the transaction is not a `WIN`.
 * @throws {@link InvalidTransactionStateError} If the transaction is terminal.
 */
export function applyWin(
  transaction: WagerTransaction,
  wallet: Wallet,
  reference: WagerTransaction | undefined,
  ids: { entryId: string },
): WalletLedgerEntry | undefined {
  if (transaction.kind !== WagerTransactionKind.Win) {
    throw new Error(`applyWin takes a WIN, got ${transaction.kind}`);
  }
  const walletRejection = walletRejectionOf(transaction, wallet);
  if (walletRejection !== undefined) {
    rejectOn(transaction, wallet, { code: walletRejection });
    return undefined;
  }
  let referenceTransactionId: string | undefined;
  if (transaction.referenceExternalTransactionId !== undefined) {
    const resolution = resolveReference(transaction, reference, ACCEPTED_REFERENCE_KINDS);
    if (resolution.outcome === 'wait') {
      transaction.markPendingReference();
      return undefined;
    }
    if (resolution.outcome === 'rejected') {
      rejectOn(transaction, wallet, resolution);
      return undefined;
    }
    referenceTransactionId = resolution.reference.id;
  }
  const entry = wallet.credit({ money: transaction.money, entryId: ids.entryId, transactionId: transaction.id });
  transaction.markProcessed({
    at: entry.createdAt,
    balanceAfter: wallet.balance,
    walletVersionObserved: wallet.version,
    referenceTransactionId,
  });
  return entry;
}
