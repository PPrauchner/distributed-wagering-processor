/**
 * Resolves the transactions pending their reference (`ARCHITECTURE.md` §
 * Referências fora de ordem). Only this worker resolves them, on every
 * instance over the same database:
 *
 * - claims a batch of due ones by lease, in a short unit of work of its own;
 * - resolves each in a unit of work of its own that starts by locking its
 *   wallet, then the item itself, and re-reads it under those locks — one
 *   already resolved by another worker is left alone;
 * - looks for the reference **before** the TTL, with the rules of the arrival:
 *   present and valid → `PROCESSED`; present and invalid → `REJECTED` with its
 *   code; absent (or itself pending) with the TTL over → `REJECTED`
 *   `REFERENCE_NOT_FOUND`; absent within the TTL → counted and rescheduled;
 * - records the outcome's events with the transaction's original correlation
 *   id, in the SQL transaction of the outcome.
 *
 * Each recorded outcome, each reschedule and each lock conflict is counted
 * (`ARCHITECTURE.md` § Observabilidade), on the `WORKER` channel.
 *
 * A transient failure reschedules the item, with no limit of attempts — the
 * TTL already limits the wait; a permanent one — or one the classifier left
 * unclassified, recorded `INFRA_UNEXPECTED` — records it `FAILED` in a second
 * unit of work, with `WagerTransactionFailed` and an alert. Both re-read the
 * item under its own lock and record nothing when another worker resolved it
 * meanwhile — never an `INFRA_INVARIANT_VIOLATION` from the immutability
 * trigger. With no caller to tell, an error
 * that still escapes an item is logged and left to its lease: the rest of the
 * batch goes on. A worker that dies leaves its items leased, and another takes
 * them once the lease expires.
 *
 * @packageDocumentation
 */
import type { OutboxRepositories } from '../../messaging/application/outbox-repository.ts';
import type { ContextLog } from '../../shared/application/context-log.ts';
import { FaultPoint, type FaultInjection } from '../../shared/application/fault-injector.ts';
import { PermanentFailureError, TransientFailureError } from '../../shared/application/infrastructure-failures.ts';
import type { UnitOfWork } from '../../shared/application/unit-of-work.ts';
import { FailureCode } from '../../shared/domain/failure-code.ts';
import type { WalletRepositories } from '../../wallet/application/wallet-repository.ts';
import { WagerTransactionStatus, type WagerTransaction } from '../domain/wager-transaction.ts';
import { rejectOn } from '../domain/wallet-coherence.ts';
import { enqueueFailureEvent, enqueueOutcomeEvents, settleOnWallet, type ReferenceWaitPolicy } from './settle-wager-transaction.ts';
import type { PendingReferenceClaim, WageringRepositories } from './wager-transaction-repository.ts';
import type { WageringMetrics } from './wagering-metrics.ts';

/** How many pending references one cycle claims. */
export const PENDING_REFERENCES_BATCH_SIZE = 10;

export interface ResolvePendingReferencesOptions {
  leaseMs: number;
  referenceWait: ReferenceWaitPolicy;
}

export class ResolvePendingReferences {
  constructor(
    private readonly unitOfWork: UnitOfWork<
      WalletRepositories & WageringRepositories & OutboxRepositories & FaultInjection
    >,
    private readonly generateId: () => string,
    private readonly options: ResolvePendingReferencesOptions,
    private readonly log: ContextLog,
    private readonly metrics: WageringMetrics,
  ) {}

  /**
   * One cycle: claim a batch, then resolve each claimed item in turn.
   *
   * @param stopping - Asked before each item: once it says so, the items not
   *   started are left leased, and claimed again when the lease expires.
   * @returns How many items were claimed; 0 when none was due.
   */
  async resolveDue(stopping: () => boolean = () => false): Promise<number> {
    const claimed = await this.unitOfWork.run(({ transactions }) =>
      transactions.claimDuePendingReferences(PENDING_REFERENCES_BATCH_SIZE, this.options.leaseMs),
    );
    for (const claim of claimed) {
      if (stopping()) break;
      await this.log.inContext({ transactionId: claim.transactionId, walletId: claim.walletId }, () =>
        this.resolveIsolated(claim),
      );
    }
    return claimed.length;
  }

  /** Resolves the item; an error that escapes it is logged, never thrown into the batch. */
  private async resolveIsolated(claim: PendingReferenceClaim): Promise<void> {
    try {
      await this.resolveOne(claim);
    } catch (error) {
      this.log.warn('pending reference left to its lease after an error', { error: errorName(error) });
    }
  }

  private async resolveOne(claim: PendingReferenceClaim): Promise<void> {
    try {
      const attempted = await this.attempt(claim);
      // Counted once committed.
      if (attempted === 'retried') this.metrics.pendingReferenceRetried();
      else if (attempted) this.metrics.pendingReferenceResolved(attempted.kind, attempted.status);
    } catch (error) {
      if (error instanceof TransientFailureError) {
        if (error.lockConflict) this.metrics.lockConflict(error.lockConflict);
        this.log.info('pending reference attempt failed transiently, rescheduled', { failureCode: error.failureCode });
        await this.rescheduleAfterTransient(claim);
        return;
      }
      if (error instanceof PermanentFailureError) {
        await this.recordFailure(claim, error);
        return;
      }
      // Unclassified — a bug or a domain error: retrying would fail the same way, forever.
      await this.recordFailure(claim, new PermanentFailureError(FailureCode.InfraUnexpected, { cause: error }));
    }
  }

  /**
   * The unit of work that resolves the item, or counts and reschedules it.
   *
   * @returns The transaction resolved, `'retried'` when rescheduled, nothing
   *   when another worker resolved it first.
   */
  private attempt(claim: PendingReferenceClaim): Promise<WagerTransaction | 'retried' | undefined> {
    return this.unitOfWork.run(async ({ wallets, ledger, transactions, outbox, faults }) => {
      // The wallet lock comes first, as in every SQL transaction touching a wallet (ADR 0002).
      const wallet = await wallets.findByIdForUpdate(claim.walletId);
      await faults.inject(FaultPoint.TransientFailureInResolution, { transactionId: claim.transactionId });
      const pending = await transactions.findByIdForUpdate(claim.transactionId);
      // Another worker resolved it meanwhile.
      if (!wallet || !pending || pending.status !== WagerTransactionStatus.PendingReference) return undefined;
      this.log.enrich({ correlationId: pending.correlationId, providerId: pending.providerId });

      // The reference is looked for before the TTL: one that arrived is never turned down for being late.
      const entry = await settleOnWallet(pending, wallet, transactions, this.generateId);
      if (pending.status === WagerTransactionStatus.PendingReference) {
        if (await transactions.isReferenceWaitOver(pending.id, this.options.referenceWait.ttlMs)) {
          rejectOn(pending, wallet, { code: FailureCode.ReferenceNotFound });
        } else {
          pending.retryReference(new Date(), this.options.referenceWait.backoff);
          return 'retried';
        }
      }
      if (entry) ledger.add(entry);
      enqueueOutcomeEvents(
        outbox,
        { transaction: pending, wallet, entry },
        { generateId: this.generateId, ttlMs: this.options.referenceWait.ttlMs },
      );
      this.logSettled(pending);
      await faults.inject(FaultPoint.InvariantViolationBeforeCommit, { transactionId: pending.id });
      return pending;
    });
  }

  /**
   * Counts the failed attempt and reschedules it, in a short unit of work. If
   * even that fails, the lease expires and the item is claimed again.
   */
  private async rescheduleAfterTransient(claim: PendingReferenceClaim): Promise<void> {
    try {
      const rescheduled = await this.unitOfWork.run(async ({ transactions }) => {
        // Under its lock: one another worker resolved meanwhile is left alone.
        const pending = await transactions.findByIdForUpdate(claim.transactionId);
        if (pending?.status !== WagerTransactionStatus.PendingReference) return false;
        pending.retryReference(new Date(), this.options.referenceWait.backoff);
        return true;
      });
      if (rescheduled) this.metrics.pendingReferenceRetried();
    } catch (error) {
      if (!(error instanceof TransientFailureError)) throw error;
      this.log.info('pending reference not rescheduled; its lease will expire', { failureCode: error.failureCode });
    }
  }

  /**
   * The second unit of work: `FAILED`, with nothing observed, its
   * `WagerTransactionFailed` — none when another worker resolved it
   * meanwhile —, and an alert.
   */
  private async recordFailure(claim: PendingReferenceClaim, error: PermanentFailureError): Promise<void> {
    const failed = await this.unitOfWork.run(async ({ transactions, outbox }) => {
      // Under its lock: one another worker resolved meanwhile is left alone.
      const pending = await transactions.findByIdForUpdate(claim.transactionId);
      if (pending?.status !== WagerTransactionStatus.PendingReference) return undefined;
      pending.fail(error.failureCode);
      enqueueFailureEvent(outbox, pending, this.generateId);
      return pending;
    });
    if (failed) {
      this.metrics.pendingReferenceResolved(failed.kind, failed.status);
      this.log.warn('pending reference failed permanently', {
        failureCode: error.failureCode,
        error: errorName(error.cause ?? error),
      });
    }
  }

  private logSettled(transaction: WagerTransaction): void {
    const { kind, status, failureCode } = transaction;
    this.log.info('pending reference resolved', { kind, status, failureCode });
  }
}

/** The error's class name, for the log: never its message, which may carry values. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
