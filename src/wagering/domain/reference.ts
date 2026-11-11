/**
 * Resolution of a transaction's reference (`CONTEXT.md` § Referência): whether
 * it is there to be relied on, and coherent with the transaction citing it.
 * Shared by every kind that cites one — the win now, the refund and the
 * rollback after it, which add their own rules (equal amount, undone once) on
 * top. The rules run in the documented order and the first violation decides
 * (`ARCHITECTURE.md` § Ordem das validações, step 8).
 *
 * @packageDocumentation
 */
import { FailureCode } from '../../shared/domain/failure-code.ts';
import { WagerTransactionStatus, type WagerTransaction, type WagerTransactionKind } from './wager-transaction.ts';

/** What resolving a reference decided. */
export type ReferenceResolution =
  /** The reference is absent, or itself waiting for its own: the citing transaction waits. */
  | { outcome: 'wait' }
  | { outcome: 'rejected'; code: FailureCode; message?: string }
  | { outcome: 'resolved'; reference: WagerTransaction };

// The fields a reference must share with the transaction citing it, in the
// order the first divergent one is reported. The provider never diverges: the
// reference is looked up by the provider of the citing transaction.
const COHERENT_FIELDS: [string, (transaction: WagerTransaction) => string][] = [
  ['playerId', (transaction) => transaction.playerId],
  ['walletId', (transaction) => transaction.walletId],
  ['currency', (transaction) => transaction.money.currency],
  ['roundId', (transaction) => transaction.roundId],
];

/**
 * @param transaction - The transaction citing the reference.
 * @param reference - The transaction found by the citing provider and the cited
 *   external id, or `undefined` when there is none yet.
 * @param acceptedKinds - The kinds the citing transaction may refer to.
 * @returns Wait; a rejection — `REFERENCE_NOT_PROCESSED`,
 *   `REFERENCE_KIND_NOT_ALLOWED` or `REFERENCE_MISMATCH` with the first divergent
 *   field in its message —; or the resolved reference.
 */
export function resolveReference(
  transaction: WagerTransaction,
  reference: WagerTransaction | undefined,
  acceptedKinds: ReadonlySet<WagerTransactionKind>,
): ReferenceResolution {
  if (reference === undefined || reference.status === WagerTransactionStatus.PendingReference) {
    return { outcome: 'wait' };
  }
  if (reference.status !== WagerTransactionStatus.Processed) {
    return { outcome: 'rejected', code: FailureCode.ReferenceNotProcessed };
  }
  if (!acceptedKinds.has(reference.kind)) {
    return { outcome: 'rejected', code: FailureCode.ReferenceKindNotAllowed };
  }
  const divergent = COHERENT_FIELDS.find(([, valueOf]) => valueOf(reference) !== valueOf(transaction));
  if (divergent !== undefined) {
    const [field] = divergent;
    return {
      outcome: 'rejected',
      code: FailureCode.ReferenceMismatch,
      message: `reference "${reference.externalTransactionId}" has another ${field}`,
    };
  }
  return { outcome: 'resolved', reference };
}
