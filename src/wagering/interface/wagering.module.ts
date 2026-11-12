/**
 * Nest module of wagering: its controller, its queue consumer, the worker of
 * pending references and their use cases, wired to the unit of work, the input queue and its DLQ, the metrics and the log by token
 * so the use case stays free of NestJS.
 *
 * @packageDocumentation
 */
import { Module, type DynamicModule } from '@nestjs/common';
import { CONSUMER_METRICS, type ConsumerMetrics } from '../../messaging/application/consumer-metrics.ts';
import { WAGER_TRANSACTIONS_DLQ, type DeadLetterQueue } from '../../messaging/application/dead-letter-queue.ts';
import type { InboxRepositories } from '../../messaging/application/inbox-repository.ts';
import { WAGER_TRANSACTIONS_QUEUE, type InputQueue } from '../../messaging/application/input-queue.ts';
import type { OutboxRepositories } from '../../messaging/application/outbox-repository.ts';
import { CONTEXT_LOG, type ContextLog } from '../../shared/application/context-log.ts';
import type { FaultInjection, FaultPoint } from '../../shared/application/fault-injector.ts';
import { UNIT_OF_WORK, type UnitOfWork } from '../../shared/application/unit-of-work.ts';
import { CrashFaultInjector, type Crash } from '../../shared/infrastructure/crash-fault-injector.ts';
import type { WalletRepositories } from '../../wallet/application/wallet-repository.ts';
import { GetWagerTransaction } from '../application/get-wager-transaction.ts';
import { ProcessWagerTransaction } from '../application/process-wager-transaction.ts';
import { RecordRejectedSubmission } from '../application/record-rejected-submission.ts';
import { ResolvePendingReferences } from '../application/resolve-pending-references.ts';
import type { RejectedSubmissionRepositories } from '../application/rejected-submission-repository.ts';
import type { WageringRepositories } from '../application/wager-transaction-repository.ts';
import { WAGERING_METRICS, type WageringMetrics } from '../application/wagering-metrics.ts';
import { PendingReferencesWorker } from './pending-references.worker.ts';
import { RejectedSubmissionAudit } from './rejected-submission.audit.ts';
import { WagerTransactionConsumer } from './wager-transaction.consumer.ts';
import { ProviderWagerTransactionController, WagerTransactionController } from './wager-transaction.controller.ts';

/** What the wagering module is configured with; the composition root translates its configuration to it. */
export interface WageringModuleOptions {
  /** Whether this instance consumes the input queue, and how it gives up and drains. */
  wagerTransactionsConsumer: { enabled: boolean; maxReceives: number; retryMaxSeconds: number; drainTimeoutMs: number };
  /** How a pending reference waits, and whether this instance resolves them. */
  pendingReferences: {
    enabled: boolean;
    ttlMs: number;
    pollIntervalMs: number;
    leaseMs: number;
    retryBaseMs: number;
    retryMaxMs: number;
  };
  /** The fault points enabled; none outside the tests. */
  faultPoints: readonly FaultPoint[];
  /** How the consumer dies at an enabled crash point; by default, a `SimulatedCrashError`. */
  crash?: Crash;
}

@Module({})
export class WageringModule {
  /**
   * @param options - The consumer, the pending references, the fault points and the crash.
   * @returns The module, exporting the audit of refused submissions.
   */
  static forRoot(options: WageringModuleOptions): DynamicModule {
    const { crash } = options;
    const { ttlMs, retryBaseMs, retryMaxMs } = options.pendingReferences;
    const referenceWait = { ttlMs, backoff: { baseMs: retryBaseMs, maxMs: retryMaxMs } };
    return {
      module: WageringModule,
      controllers: [WagerTransactionController, ProviderWagerTransactionController],
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
          provide: GetWagerTransaction,
          inject: [UNIT_OF_WORK],
          useFactory: (unitOfWork: UnitOfWork<WageringRepositories>) => new GetWagerTransaction(unitOfWork),
        },
        {
          provide: ResolvePendingReferences,
          inject: [UNIT_OF_WORK, CONTEXT_LOG, WAGERING_METRICS],
          useFactory: (
            unitOfWork: UnitOfWork<WalletRepositories & WageringRepositories & OutboxRepositories & FaultInjection>,
            log: ContextLog,
            metrics: WageringMetrics,
          ) =>
            new ResolvePendingReferences(
              unitOfWork,
              () => Bun.randomUUIDv7(),
              { leaseMs: options.pendingReferences.leaseMs, referenceWait },
              log,
              metrics,
            ),
        },
        {
          provide: PendingReferencesWorker,
          inject: [ResolvePendingReferences],
          useFactory: (resolvePendingReferences: ResolvePendingReferences) =>
            new PendingReferencesWorker(resolvePendingReferences, {
              enabled: options.pendingReferences.enabled,
              pollIntervalMs: options.pendingReferences.pollIntervalMs,
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
            const { enabled, maxReceives, retryMaxSeconds, drainTimeoutMs } = options.wagerTransactionsConsumer;
            return new WagerTransactionConsumer(
              {
                queue,
                deadLetters,
                processWagerTransaction,
                recordRejectedSubmission,
                metrics,
                log,
                faults: new CrashFaultInjector(options.faultPoints, crash),
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
