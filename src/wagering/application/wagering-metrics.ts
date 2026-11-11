/**
 * `WageringMetrics` port: what the wagering use cases count and time, without
 * depending on a metrics library (`ARCHITECTURE.md` § Observabilidade).
 *
 * @packageDocumentation
 */
import type { LockConflictReason } from '../../shared/application/infrastructure-failures.ts';
import type { SubmissionChannel } from '../domain/rejected-submission.ts';
import type { WagerTransactionKind, WagerTransactionStatus } from '../domain/wager-transaction.ts';

/** Injection token of the wagering metrics implementation. */
export const WAGERING_METRICS = Symbol('WageringMetrics');

/** One submission that ended in a transaction, new or replayed. */
export interface WagerTransactionObservation {
  channel: SubmissionChannel;
  kind: WagerTransactionKind;
  status: WagerTransactionStatus;
  idempotentReplay: boolean;
  durationSeconds: number;
}

export interface WageringMetrics {
  /** A new transaction counts by kind, status and channel; a replay counts as a replay. */
  transactionSettled(observation: WagerTransactionObservation): void;
  idempotencyConflict(channel: SubmissionChannel): void;
  lockConflict(reason: LockConflictReason): void;
  /** A submission not admitted, by its failure code. */
  submissionNotAdmitted(failureCode: string, channel: SubmissionChannel): void;
}
