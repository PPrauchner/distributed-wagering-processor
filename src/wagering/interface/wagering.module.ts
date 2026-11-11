/**
 * Nest module of wagering: its controller, its queue consumer, the worker of
 * pending references and their use cases, wired to the unit of work, the input queue and its DLQ, the metrics and the log by token
 * so the use case stays free of NestJS.
 *
 * @packageDocumentation
 */
import { Module, type DynamicModule } from '@nestjs/common';
import type { AppConfig } from '../../config.ts';
import { CONSUMER_METRICS, type ConsumerMetrics } from '../../messaging/application/consumer-metrics.ts';
import { WAGER_TRANSACTIONS_DLQ, type DeadLetterQueue } from '../../messaging/application/dead-letter-queue.ts';
import type { InboxRepositories } from '../../messaging/application/inbox-repository.ts';
import { WAGER_TRANSACTIONS_QUEUE, type InputQueue } from '../../messaging/application/input-queue.ts';
import type { OutboxRepositories } from '../../messaging/application/outbox-repository.ts';
import { CONTEXT_LOG, type ContextLog } from '../../shared/application/context-log.ts';
import type { FaultInjection } from '../../shared/application/fault-injector.ts';
import { UNIT_OF_WORK, type UnitOfWork } from '../../shared/application/unit-of-work.ts';
import { CrashFaultInjector } from '../../shared/infrastructure/crash-fault-injector.ts';
import type { WalletRepositories } from '../../wallet/application/wallet-repository.ts';
import { ProcessWagerTransaction } from '../application/process-wager-transaction.ts';
import { RecordRejectedSubmission } from '../application/record-rejected-submission.ts';
import { ResolvePendingReferences } from '../application/resolve-pending-references.ts';
import type { RejectedSubmissionRepositories } from '../application/rejected-submission-repository.ts';
import type { WageringRepositories } from '../application/wager-transaction-repository.ts';
import { WAGERING_METRICS, type WageringMetrics } from '../application/wagering-metrics.ts';
import { PendingReferencesWorker } from './pending-references.worker.ts';
import { RejectedSubmissionAudit } from './rejected-submission.audit.ts';
import { WagerTransactionConsumer } from './wager-transaction.consumer.ts';
import { WagerTransactionController } from './wager-transaction.controller.ts';

@Module({})
export class WageringModule {
  /**
   * @param config - Whether this instance consumes the input queue, how a
   *   pending reference waits and whether this instance resolves them, and the
   *   fault points enabled (none outside the tests).
   * @returns The module, exporting the audit of refused submissions.
   */
  static forRoot(
    config: Pick<AppConfig, 'wagerTransactionsConsumer' | 'pendingReferences' | 'faultPoints'>,
  ): DynamicModule {
    const { ttlMs, retryBaseMs, retryMaxMs } = config.pendingReferences;
    const referenceWait = { ttlMs, backoff: { baseMs: retryBaseMs, maxMs: retryMaxMs } };
    return {
      module: WageringModule,
      controllers: [WagerTransactionController],
      providers: [
        {
          provide: ProcessWagerTransaction,
          inject: [UNIT_OF_WORK, WAGERING_METRICS, CONTEXT_LOG],
          useFactory: (
            unitOfWork: UnitOfWork<
              WalletRepositories & WageringRepositories & OutboxRepositories & InboxRepositories & FaultInjection
            >,
            metrics: WageringMetrics,
            log: ContextLog,
          ) => new ProcessWagerTransaction(unitOfWork, () => Bun.randomUUIDv7(), metrics, log, referenceWait),
        },
        {
          provide: ResolvePendingReferences,
          inject: [UNIT_OF_WORK, CONTEXT_LOG],
          useFactory: (
            unitOfWork: UnitOfWork<WalletRepositories & WageringRepositories & OutboxRepositories & FaultInjection>,
            log: ContextLog,
          ) =>
            new ResolvePendingReferences(
              unitOfWork,
              () => Bun.randomUUIDv7(),
              { leaseMs: config.pendingReferences.leaseMs, referenceWait },
              log,
            ),
        },
        {
          provide: PendingReferencesWorker,
          inject: [ResolvePendingReferences],
          useFactory: (resolvePendingReferences: ResolvePendingReferences) =>
            new PendingReferencesWorker(resolvePendingReferences, {
              enabled: config.pendingReferences.enabled,
              pollIntervalMs: config.pendingReferences.pollIntervalMs,
            }),
        },
        {
          provide: WagerTransactionConsumer,
          inject: [
            WAGER_TRANSACTIONS_QUEUE,
            WAGER_TRANSACTIONS_DLQ,
            ProcessWagerTransaction,
            RecordRejectedSubmission,
            CONSUMER_METRICS,
            CONTEXT_LOG,
          ],
          useFactory: (
            queue: InputQueue,
            deadLetters: DeadLetterQueue,
            processWagerTransaction: ProcessWagerTransaction,
            recordRejectedSubmission: RecordRejectedSubmission,
            metrics: ConsumerMetrics,
            log: ContextLog,
          ) => {
            const { enabled, maxReceives, retryMaxSeconds, drainTimeoutMs } = config.wagerTransactionsConsumer;
            return new WagerTransactionConsumer(
              {
                queue,
                deadLetters,
                processWagerTransaction,
                recordRejectedSubmission,
                metrics,
                log,
                faults: new CrashFaultInjector(config.faultPoints),
              },
              { enabled, maxReceives, retryMaxSeconds, drainTimeoutMs },
            );
          },
        },
        {
          provide: RecordRejectedSubmission,
          inject: [UNIT_OF_WORK, WAGERING_METRICS],
          useFactory: (unitOfWork: UnitOfWork<RejectedSubmissionRepositories>, metrics: WageringMetrics) =>
            new RecordRejectedSubmission(unitOfWork, () => Bun.randomUUIDv7(), metrics),
        },
        {
          provide: RejectedSubmissionAudit,
          inject: [RecordRejectedSubmission],
          useFactory: (record: RecordRejectedSubmission) => new RejectedSubmissionAudit(record),
        },
      ],
      // The global HTTP error filter reports the refusals to it.
      exports: [RejectedSubmissionAudit],
    };
  }
}
