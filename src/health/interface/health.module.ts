/**
 * Nest module of health: the liveness and readiness endpoints, with probes of
 * the database and of the input, event and dead-letter queues, and the metrics
 * endpoint, whose DLQ depth is read with the probes' client.
 * The queue probes have an SQS client of their own, with no retry, so a probe
 * fails within its timeout. Global: it binds the metrics ports the other
 * modules inject by token.
 *
 * @packageDocumentation
 */
import { Global, Inject, Logger, Module, type DynamicModule, type OnApplicationShutdown } from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { CONTEXT_LOG, type ContextLog } from '../../shared/application/context-log.ts';
import { CONSUMER_METRICS } from '../../messaging/application/consumer-metrics.ts';
import { INBOX_METRICS } from '../../messaging/application/inbox-metrics.ts';
import type { SqsConnectionOptions } from '../../messaging/interface/messaging.module.ts';
import { OUTBOX_METRICS } from '../../messaging/application/outbox-metrics.ts';
import type { OutboxBacklogRepositories } from '../../messaging/application/outbox-backlog.ts';
import { UNIT_OF_WORK, type UnitOfWork } from '../../shared/application/unit-of-work.ts';
import { WAGERING_METRICS } from '../../wagering/application/wagering-metrics.ts';
import { RECONCILIATION_DIVERGENCE_COUNTER } from '../../wallet/application/reconciliation.ts';
import { WALLET_METRICS } from '../../wallet/application/wallet-metrics.ts';
import { CheckReadiness } from '../application/check-readiness.ts';
import { DatabaseReadiness } from '../infrastructure/database-readiness.ts';
import { PrometheusMetrics } from '../infrastructure/prometheus-metrics.ts';
import { SqsQueueDepth } from '../infrastructure/sqs-queue-depth.ts';
import { SqsQueueReadiness } from '../infrastructure/sqs-queue-readiness.ts';
import { HealthController } from './health.controller.ts';
import { MetricsController } from './metrics.controller.ts';

/** What the health module is configured with; the composition root translates its configuration to it. */
export interface HealthModuleOptions {
  sqs: SqsConnectionOptions;
  /** The queues the readiness probes look up; the DLQ's depth is also a metric. */
  queues: { wagerTransactions: string; wagerTransactionsDlq: string; wageringEvents: string };
}

const PROBE_SQS_CLIENT = Symbol('ProbeSQSClient');
/** Each probe's time limit, and the outbox gauges' read limit (`ARCHITECTURE.md` § Observabilidade). */
const PROBE_TIMEOUT_MS = 1000;

@Global()
@Module({})
export class HealthModule implements OnApplicationShutdown {
  constructor(@Inject(PROBE_SQS_CLIENT) private readonly sqs: SQSClient) {}

  /**
   * @param options - The SQS connection and the queues to probe.
   * @returns The module, with its controllers, exporting the metrics ports.
   */
  static forRoot(options: HealthModuleOptions): DynamicModule {
    const { sqs, queues } = options;
    return {
      module: HealthModule,
      controllers: [HealthController, MetricsController],
      providers: [
        {
          provide: PrometheusMetrics,
          inject: [UNIT_OF_WORK, PROBE_SQS_CLIENT],
          useFactory: (unitOfWork: UnitOfWork<OutboxBacklogRepositories>, client: SQSClient) => {
            const dlq = new SqsQueueDepth(client, queues.wagerTransactionsDlq);
            return new PrometheusMetrics(
              {
                readBacklog: () => unitOfWork.run(({ outboxBacklog }) => outboxBacklog.read()),
                readDlqDepth: () => dlq.read(),
              },
              { timeoutMs: PROBE_TIMEOUT_MS, log: new Logger('Metrics') },
            );
          },
        },
        { provide: WAGERING_METRICS, useExisting: PrometheusMetrics },
        { provide: INBOX_METRICS, useExisting: PrometheusMetrics },
        { provide: CONSUMER_METRICS, useExisting: PrometheusMetrics },
        { provide: OUTBOX_METRICS, useExisting: PrometheusMetrics },
        { provide: RECONCILIATION_DIVERGENCE_COUNTER, useExisting: PrometheusMetrics },
        { provide: WALLET_METRICS, useExisting: PrometheusMetrics },
        {
          provide: PROBE_SQS_CLIENT,
          useFactory: () =>
            new SQSClient({
              endpoint: sqs.endpoint,
              region: sqs.region,
              credentials: { accessKeyId: sqs.accessKeyId, secretAccessKey: sqs.secretAccessKey },
              maxAttempts: 1,
            }),
        },
        {
          provide: CheckReadiness,
          inject: [MikroORM, PROBE_SQS_CLIENT, CONTEXT_LOG],
          useFactory: (orm: MikroORM, client: SQSClient, log: ContextLog) =>
            new CheckReadiness(
              [
                new DatabaseReadiness(orm.em),
                new SqsQueueReadiness(client, queues.wagerTransactions),
                new SqsQueueReadiness(client, queues.wageringEvents),
                new SqsQueueReadiness(client, queues.wagerTransactionsDlq),
              ],
              PROBE_TIMEOUT_MS,
              log,
            ),
        },
      ],
      exports: [
        WAGERING_METRICS,
        INBOX_METRICS,
        CONSUMER_METRICS,
        OUTBOX_METRICS,
        WALLET_METRICS,
        RECONCILIATION_DIVERGENCE_COUNTER,
      ],
    };
  }

  onApplicationShutdown(): void {
    this.sqs.destroy();
  }
}
