/**
 * Settling a wager transaction on its locked wallet, and the integration events
 * of its outcome — shared by the submission and by the worker that resolves the
 * pending references, so a pending one is resolved by the very rules and
 * events of its arrival (`ARCHITECTURE.md` § Ordem das validações, step 8; §
 * Eventos de integração).
 *
 * @packageDocumentation
 */
import type { OutboxRepository } from '../../messaging/application/outbox-repository.ts';
import { OutboxMessage } from '../../messaging/domain/outbox-message.ts';
import type { Wallet } from '../../wallet/domain/wallet.ts';
import { WalletBalanceChanged } from '../../wallet/domain/wallet-balance-changed.ts';
import type { WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry.ts';
import { applyBet } from '../domain/bet.ts';
import { applyDependentTransaction, type CitedReference } from '../domain/dependent-transaction.ts';
import { applyLoss } from '../domain/loss.ts';
import type { ReferenceRetryBackoff } from '../domain/reference-wait.ts';
import { applyWin } from '../domain/win.ts';
import {
  WagerTransactionFailed,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from '../domain/wager-transaction-events.ts';
import { WagerTransactionKind, WagerTransactionStatus, type WagerTransaction } from '../domain/wager-transaction.ts';
import type { WagerTransactionRepository } from './wager-transaction-repository.ts';

/** How a transaction citing a reference not there yet waits for it. */
export interface ReferenceWaitPolicy {
  /** How long it waits from its creation. */
  ttlMs: number;
  /** When the worker tries it next. */
  backoff: ReferenceRetryBackoff;
}

/**
 * The rules of the transaction's kind, on its locked wallet. A transaction
 * citing a reference reads it by its provider and external id; a refund or
 * rollback also reads, under the same lock, whether it was already undone.
 *
 * @param transaction - The transaction, `PENDING` or waiting for its reference.
 * @param wallet - Its wallet, read under lock.
 * @param transactions - The repository of the unit of work holding the lock.
 * @param generateId - Generates the id of the ledger entry.
 * @returns The ledger entry to persist, when the balance moved.
 * @throws {@link Error} If it is an `OPENING`, which only the wallet's opening records.
 */
export async function settleOnWallet(
  transaction: WagerTransaction,
  wallet: Wallet,
  transactions: WagerTransactionRepository,
  generateId: () => string,
): Promise<WalletLedgerEntry | undefined> {
  const ids = { entryId: generateId() };
  switch (transaction.kind) {
    case WagerTransactionKind.Bet:
      return applyBet(transaction, wallet, ids);
    case WagerTransactionKind.Win: {
      const { referenceExternalTransactionId } = transaction;
      const reference =
        referenceExternalTransactionId === undefined
          ? undefined
          : ((await transactions.findByExternalId(transaction.providerId, referenceExternalTransactionId)) ??
            undefined);
      return applyWin(transaction, wallet, reference, ids);
    }
    case WagerTransactionKind.Loss:
      applyLoss(transaction, wallet);
      return undefined;
    case WagerTransactionKind.Refund:
    case WagerTransactionKind.Rollback:
      return applyDependentTransaction(transaction, wallet, await citedReference(transactions, transaction), ids);
    case WagerTransactionKind.Opening:
      throw new Error(`${transaction.kind} is internal: only the wallet's opening records it`);
    default: {
      const unhandled: never = transaction.kind;
      throw new Error(`unknown wager transaction kind: ${String(unhandled)}`);
    }
  }
}

/**
 * The outcome's integration events, with the transaction's original
 * correlation id and the transaction as their cause: processed, with its
 * balance change when the balance moved; rejected; waiting for a reference,
 * with when the wait expires. Added before anything that may still fail in the
 * unit of work, so they are committed or rolled back with the outcome.
 *
 * @param outbox - The outbox of the unit of work recording the outcome.
 * @param outcome - The transaction, its wallet and the ledger entry it wrote, if any.
 * @param options - Generates the event ids; how long a pending one waits.
 */
export function enqueueOutcomeEvents(
  outbox: OutboxRepository,
  outcome: { transaction: WagerTransaction; wallet: Wallet; entry: WalletLedgerEntry | undefined },
  options: { generateId: () => string; ttlMs: number },
): void {
  const { transaction, wallet, entry } = outcome;
  const { generateId, ttlMs } = options;
  const context = { correlationId: transaction.correlationId, causationId: transaction.id };
  if (transaction.status === WagerTransactionStatus.Rejected) {
    const rejected = WagerTransactionRejected.from(transaction, context, { eventId: generateId(), at: new Date() });
    outbox.add(OutboxMessage.enqueue(rejected));
    return;
  }
  if (transaction.status === WagerTransactionStatus.PendingReference) {
    const pending = WagerTransactionPendingReference.from(transaction, context, { eventId: generateId(), ttlMs });
    outbox.add(OutboxMessage.enqueue(pending));
    return;
  }
  if (transaction.status !== WagerTransactionStatus.Processed) return;
  const processed = WagerTransactionProcessed.from(transaction, context, { eventId: generateId() });
  outbox.add(OutboxMessage.enqueue(processed));
  if (entry === undefined) return;
  const changed = WalletBalanceChanged.from(wallet, entry, context, { eventId: generateId() });
  outbox.add(OutboxMessage.enqueue(changed));
}

/**
 * The event of a `FAILED` outcome — and no other: nothing was observed of the
 * wallet, so no balance change goes with it. Enqueued by the unit of work that
 * records the `FAILED`, so it commits or rolls back with it.
 *
 * @param outbox - The outbox of the unit of work recording the `FAILED`.
 * @param transaction - The transaction, just recorded `FAILED`.
 * @param generateId - Generates the event id.
 * @throws {@link EventOutcomeMismatchError} If the transaction is not `FAILED`.
 */
export function enqueueFailureEvent(
  outbox: OutboxRepository,
  transaction: WagerTransaction,
  generateId: () => string,
): void {
  const context = { correlationId: transaction.correlationId, causationId: transaction.id };
  const failed = WagerTransactionFailed.from(transaction, context, { eventId: generateId(), at: new Date() });
  outbox.add(OutboxMessage.enqueue(failed));
}

/**
 * The reference a refund or rollback cites, and whether it was already undone
 * — asked only of a processed one, the only kind that can have been.
 */
async function citedReference(
  transactions: WagerTransactionRepository,
  transaction: WagerTransaction,
): Promise<CitedReference | undefined> {
  const { providerId, referenceExternalTransactionId } = transaction;
  if (referenceExternalTransactionId === undefined) return undefined;
  const reference = await transactions.findByExternalId(providerId, referenceExternalTransactionId);
  if (!reference) return undefined;
  const alreadyReversed =
    reference.status === WagerTransactionStatus.Processed && (await transactions.isReversed(reference.id));
  return { transaction: reference, alreadyReversed };
}
