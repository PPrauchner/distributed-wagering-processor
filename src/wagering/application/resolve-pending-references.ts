/**
 * Resolves the transactions pending their reference (`ARCHITECTURE.md` §
 * Referências fora de ordem). Only this worker resolves them, on every
 * instance over the same database:
 *
 * - claims a batch of due ones by lease, in a short unit of work of its own;
 * - resolves each in a unit of work of its own that starts by locking its
 *   wallet and re-reads it under that lock — one already resolved by another
 *   worker is left alone;
 * - looks for the reference **before** the TTL, with the rules of the arrival:
 *   present and valid → `PROCESSED`; present and invalid → `REJECTED` with its
 *   code; absent (or itself pending) with the TTL over → `REJECTED`
 *   `REFERENCE_NOT_FOUND`; absent within the TTL → counted and rescheduled;
 * - records the outcome's events with the transaction's original correlation
 *   id, in the SQL transaction of the outcome.
 *
 * A transient failure reschedules the item, with no limit of attempts — the
 * TTL already limits the wait; a permanent one records it `FAILED` in a second
 * unit of work, with an alert and no event. A worker that dies leaves its
 * items leased, and another takes them once the lease expires.
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
import { enqueueOutcomeEvents, settleOnWallet, type ReferenceWaitPolicy } from './settle-wager-transaction.ts';
import type { PendingReferenceClaim, WageringRepositories } from './wager-transaction-repository.ts';

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
  ) {}

  /**
   * One cycle: claim a batch, then resolve each claimed item in turn.
   *
   * @returns How many items were claimed; 0 when none was due.
   */
  async resolveDue(): Promise<number> {
    const claimed = await this.unitOfWork.run(({ transactions }) =>
      transactions.claimDuePendingReferences(PENDING_REFERENCES_BATCH_SIZE, this.options.leaseMs),
    );
    for (const claim of claimed) {
      await this.log.inContext({ transactionId: claim.transactionId, walletId: claim.walletId }, () =>
        this.resolveOne(claim),
      );
    }
    return claimed.length;
  }

  private async resolveOne(claim: PendingReferenceClaim): Promise<void> {
    try {
      await this.attempt(claim);
    } catch (error) {
      if (error instanceof TransientFailureError) {
        this.log.info('pending reference attempt failed transiently, rescheduled', { failureCode: error.failureCode });
        await this.rescheduleAfterTransient(claim);
        return;
      }
      if (error instanceof PermanentFailureError) {
        await this.recordFailure(claim, error);
        return;
      }
      throw error;
    }
  }

  /** The unit of work that resolves the item, or counts and reschedules it. */
  private attempt(claim: PendingReferenceClaim): Promise<void> {
    return this.unitOfWork.run(async ({ wallets, ledger, transactions, outbox, faults }) => {
      // The wallet lock comes first, as in every SQL transaction touching a wallet (ADR 0002).
      const wallet = await wallets.findByIdForUpdate(claim.walletId);
      await faults.inject(FaultPoint.TransientFailureInResolution, { transactionId: claim.transactionId });
      const pending = await transactions.findById(claim.transactionId);
      // Another worker resolved it meanwhile.
      if (!wallet || !pending || pending.status !== WagerTransactionStatus.PendingReference) return;
      this.log.enrich({ correlationId: pending.correlationId, providerId: pending.providerId });

      // The reference is looked for before the TTL: one that arrived is never turned down for being late.
      const entry = await settleOnWallet(pending, wallet, transactions, this.generateId);
      if (pending.status === WagerTransactionStatus.PendingReference) {
        if (await transactions.isReferenceWaitOver(pending.id, this.options.referenceWait.ttlMs)) {
          rejectOn(pending, wallet, { code: FailureCode.ReferenceNotFound });
        } else {
          pending.retryReference(new Date(), this.options.referenceWait.backoff);
          return;
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
    });
  }

  /**
   * Counts the failed attempt and reschedules it, in a short unit of work. If
   * even that fails, the lease expires and the item is claimed again.
   */
  private async rescheduleAfterTransient(claim: PendingReferenceClaim): Promise<void> {
    try {
      await this.unitOfWork.run(async ({ transactions }) => {
        const pending = await transactions.findById(claim.transactionId);
        if (pending?.status !== WagerTransactionStatus.PendingReference) return;
        pending.retryReference(new Date(), this.options.referenceWait.backoff);
      });
    } catch (error) {
      if (!(error instanceof TransientFailureError)) throw error;
      this.log.info('pending reference not rescheduled; its lease will expire', { failureCode: error.failureCode });
    }
  }

  /** The second unit of work: `FAILED`, with nothing observed, no event, and an alert. */
  private async recordFailure(claim: PendingReferenceClaim, error: PermanentFailureError): Promise<void> {
    const failed = await this.unitOfWork.run(async ({ transactions }) => {
      const pending = await transactions.findById(claim.transactionId);
      if (pending?.status !== WagerTransactionStatus.PendingReference) return undefined;
      pending.fail(error.failureCode);
      return pending;
    });
    if (failed) this.log.warn('pending reference failed permanently', { failureCode: error.failureCode });
  }

  private logSettled(transaction: WagerTransaction): void {
    const { kind, status, failureCode } = transaction;
    this.log.info('pending reference resolved', { kind, status, failureCode });
  }
}
