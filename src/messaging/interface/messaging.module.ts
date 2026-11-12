/**
 * Nest module of messaging: the SQS client, the event publisher over it, the
 * outbox publication use case and the loop that runs it in every instance, and
 * the input queue of the wager transactions and its DLQ, offered to every module.
 *
 * @packageDocumentation
 */
import { Inject, Module, type DynamicModule, type OnApplicationShutdown } from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';
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

/** How every SQS client of the service connects. */
export interface SqsConnectionOptions {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** What the messaging module is configured with; the composition root translates its configuration to it. */
export interface MessagingModuleOptions {
  sqs: SqsConnectionOptions;
  queues: {
    /** The input queue of the submissions. */
    wagerTransactions: string;
    /** Where the consumer sends the messages it gives up on. */
    wagerTransactionsDlq: string;
    /** Where the integration events go. */
    wageringEvents: string;
  };
  /** How the input queue is received from. */
  inputQueue: { waitTimeSeconds: number; batchSize: number; visibilityTimeoutSeconds: number };
  /** Whether this instance runs the outbox publisher, and its times. */
  outboxPublisher: {
    enabled: boolean;
    pollIntervalMs: number;
    leaseMs: number;
    retryBaseMs: number;
    retryMaxMs: number;
  };
}

const SQS_CLIENT = Symbol('SQSClient');
const EVENT_PUBLISHER = Symbol('EventPublisher');

@Module({})
export class MessagingModule implements OnApplicationShutdown {
  constructor(@Inject(SQS_CLIENT) private readonly sqs: SQSClient) {}

  /**
   * @param options - The SQS connection, the queues, how the input queue is
   *   received from and the publisher's times.
   * @returns The module, exporting the publication use case and the input queue and its DLQ.
   */
  static forRoot(options: MessagingModuleOptions): DynamicModule {
    const { sqs, queues, inputQueue, outboxPublisher } = options;
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
          useFactory: (client: SQSClient) => new SqsEventPublisher(client, queues.wageringEvents),
        },
        {
          provide: WAGER_TRANSACTIONS_QUEUE,
          inject: [SQS_CLIENT],
          useFactory: (client: SQSClient) =>
            new SqsInputQueue(client, { queueName: queues.wagerTransactions, ...inputQueue }),
        },
        {
          provide: WAGER_TRANSACTIONS_DLQ,
          inject: [SQS_CLIENT],
          useFactory: (client: SQSClient) => new SqsDeadLetterQueue(client, queues.wagerTransactionsDlq),
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
