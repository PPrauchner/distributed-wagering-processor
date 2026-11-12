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

/** The channel of the outcomes the worker of pending references records. */
export const WORKER_CHANNEL = 'WORKER';

/** Where a new transaction's outcome was recorded: a submission's channel, or the worker. */
export type OutcomeChannel = SubmissionChannel | typeof WORKER_CHANNEL;

/**
 * How a submission that did not end in a transaction ended: refused before it
 * became one, a transient failure — resend —, or a permanent one even the
 * `FAILED` could not record.
 */
export const PROCESSING_FAILURES = ['not_admitted', 'transient', 'permanent'] as const;
export type ProcessingFailure = (typeof PROCESSING_FAILURES)[number];

/** The `kind` label of a submission whose kind is not one: never the raw value. */
export const UNKNOWN_KIND = 'UNKNOWN';

/** One submission that ended in a transaction, new or replayed. */
export interface WagerTransactionObservation {
  channel: SubmissionChannel;
  kind: WagerTransactionKind;
  status: WagerTransactionStatus;
  idempotentReplay: boolean;
  durationSeconds: number;
}

/** One submission that did not end in a transaction. */
export interface ProcessingFailureObservation {
  channel: SubmissionChannel;
  /** Its kind, or {@link UNKNOWN_KIND} when it named none of them. */
  kind: WagerTransactionKind | typeof UNKNOWN_KIND;
  outcome: ProcessingFailure;
  durationSeconds: number;
}

export interface WageringMetrics {
  /** A new transaction counts by kind, status and channel; a replay counts as a replay. Timed. */
  transactionSettled(observation: WagerTransactionObservation): void;
  /** A submission that did not end in a transaction: timed, by how it ended. */
  processingFailed(observation: ProcessingFailureObservation): void;
  idempotencyConflict(channel: SubmissionChannel): void;
  lockConflict(reason: LockConflictReason): void;
  /** A submission not admitted, by its failure code. */
  submissionNotAdmitted(failureCode: string, channel: SubmissionChannel): void;
  /** The worker recorded the outcome of a pending reference. */
  pendingReferenceResolved(kind: WagerTransactionKind, status: WagerTransactionStatus): void;
  /** The worker rescheduled a pending reference: still waiting, or a transient failure. */
  pendingReferenceRetried(): void;
}
