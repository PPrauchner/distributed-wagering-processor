/**
 * Nest module of messaging: the SQS client, the event publisher over it, the
 * outbox publication use case and the loop that runs it in every instance, and
 * the input queue of the wager transactions and its DLQ, offered to every module.
 *
 * @packageDocumentation
 */
import { Inject, Module, type DynamicModule, type OnApplicationShutdown } from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';
import type { AppConfig } from '../../config.ts';
import { CONTEXT_LOG, type ContextLog } from '../../shared/application/context-log.ts';
import type { FaultInjection } from '../../shared/application/fault-injector.ts';
import { UNIT_OF_WORK, type UnitOfWork } from '../../shared/application/unit-of-work.ts';
import type { EventPublisher } from '../application/event-publisher.ts';
import { WAGER_TRANSACTIONS_DLQ } from '../application/dead-letter-queue.ts';
import { WAGER_TRANSACTIONS_QUEUE } from '../application/input-queue.ts';
import { OUTBOX_METRICS, type OutboxMetrics } from '../application/outbox-metrics.ts';
import type { OutboxRepositories } from '../application/outbox-repository.ts';
import { PublishOutbox } from '../application/publish-outbox.ts';
import { SqsDeadLetterQueue } from '../infrastructure/sqs-dead-letter-queue.ts';
import { SqsEventPublisher } from '../infrastructure/sqs-event-publisher.ts';
import { SqsInputQueue } from '../infrastructure/sqs-input-queue.ts';
import { OutboxPublisherWorker } from './outbox-publisher.worker.ts';

const SQS_CLIENT = Symbol('SQSClient');
const EVENT_PUBLISHER = Symbol('EventPublisher');

@Module({})
export class MessagingModule implements OnApplicationShutdown {
  constructor(@Inject(SQS_CLIENT) private readonly sqs: SQSClient) {}

  /**
   * @param config - The SQS connection, the event queue and the publisher's times.
   * @returns The module, exporting the publication use case.
   */
  static forRoot(config: Pick<AppConfig, 'sqs' | 'outboxPublisher' | 'wagerTransactionsConsumer'>): DynamicModule {
    const { sqs, outboxPublisher, wagerTransactionsConsumer } = config;
    return {
      module: MessagingModule,
      // Global for the input queue: its consumer lives with the use case it feeds.
      global: true,
      providers: [
        {
          provide: SQS_CLIENT,
          useFactory: () =>
            new SQSClient({
              endpoint: sqs.endpoint,
              region: sqs.region,
              credentials: { accessKeyId: sqs.accessKeyId, secretAccessKey: sqs.secretAccessKey },
            }),
        },
        {
          provide: EVENT_PUBLISHER,
          inject: [SQS_CLIENT],
          useFactory: (client: SQSClient) => new SqsEventPublisher(client, sqs.wageringEventsQueue),
        },
        {
          provide: WAGER_TRANSACTIONS_QUEUE,
          inject: [SQS_CLIENT],
          useFactory: (client: SQSClient) =>
            new SqsInputQueue(client, {
              queueName: sqs.wagerTransactionsQueue,
              waitTimeSeconds: wagerTransactionsConsumer.waitTimeSeconds,
              batchSize: wagerTransactionsConsumer.batchSize,
              visibilityTimeoutSeconds: wagerTransactionsConsumer.visibilityTimeoutSeconds,
            }),
        },
        {
          provide: WAGER_TRANSACTIONS_DLQ,
          inject: [SQS_CLIENT],
          useFactory: (client: SQSClient) => new SqsDeadLetterQueue(client, sqs.wagerTransactionsDlq),
        },
        {
          provide: PublishOutbox,
          inject: [UNIT_OF_WORK, EVENT_PUBLISHER, CONTEXT_LOG, OUTBOX_METRICS],
          useFactory: (
            unitOfWork: UnitOfWork<OutboxRepositories & FaultInjection>,
            publisher: EventPublisher,
            log: ContextLog,
            metrics: OutboxMetrics,
          ) =>
            new PublishOutbox(
              unitOfWork,
              publisher,
              {
                leaseMs: outboxPublisher.leaseMs,
                backoff: { baseMs: outboxPublisher.retryBaseMs, maxMs: outboxPublisher.retryMaxMs },
              },
              log,
              metrics,
            ),
        },
        {
          provide: OutboxPublisherWorker,
          inject: [PublishOutbox],
          useFactory: (publishOutbox: PublishOutbox) => new OutboxPublisherWorker(publishOutbox, outboxPublisher),
        },
      ],
      exports: [PublishOutbox, WAGER_TRANSACTIONS_QUEUE, WAGER_TRANSACTIONS_DLQ],
    };
  }

  // Nest shuts the module's providers down first: the loop has stopped by now.
  onApplicationShutdown(): void {
    this.sqs.destroy();
  }
}
