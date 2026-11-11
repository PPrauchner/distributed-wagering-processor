/**
 * Nest module of wagering: its controller and use case, wired to the unit of
 * work, the metrics and the log by token so the use case stays free of NestJS.
 *
 * @packageDocumentation
 */
import { Module } from '@nestjs/common';
import type { InboxRepositories } from '../../messaging/application/inbox-repository.ts';
import type { OutboxRepositories } from '../../messaging/application/outbox-repository.ts';
import { CONTEXT_LOG, type ContextLog } from '../../shared/application/context-log.ts';
import type { FaultInjection } from '../../shared/application/fault-injector.ts';
import { UNIT_OF_WORK, type UnitOfWork } from '../../shared/application/unit-of-work.ts';
import type { WalletRepositories } from '../../wallet/application/wallet-repository.ts';
import { ProcessWagerTransaction } from '../application/process-wager-transaction.ts';
import { RecordRejectedSubmission } from '../application/record-rejected-submission.ts';
import type { RejectedSubmissionRepositories } from '../application/rejected-submission-repository.ts';
import type { WageringRepositories } from '../application/wager-transaction-repository.ts';
import { WAGERING_METRICS, type WageringMetrics } from '../application/wagering-metrics.ts';
import { RejectedSubmissionAudit } from './rejected-submission.audit.ts';
import { WagerTransactionController } from './wager-transaction.controller.ts';

@Module({
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
      ) => new ProcessWagerTransaction(unitOfWork, () => Bun.randomUUIDv7(), metrics, log),
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
})
export class WageringModule {}
