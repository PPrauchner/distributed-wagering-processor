/**
 * Nest module of health: the liveness and readiness endpoints, with probes of
 * the database and of the input and event queues. The queue probes have an SQS
 * client of their own, with no retry, so a probe fails within its timeout.
 *
 * @packageDocumentation
 */
import { Inject, Module, type DynamicModule, type OnApplicationShutdown } from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import type { AppConfig } from '../../config.ts';
import { CheckReadiness } from '../application/check-readiness.ts';
import { DatabaseReadiness } from '../infrastructure/database-readiness.ts';
import { SqsQueueReadiness } from '../infrastructure/sqs-queue-readiness.ts';
import { HealthController } from './health.controller.ts';

const PROBE_SQS_CLIENT = Symbol('ProbeSQSClient');
/** Each probe's time limit (`ARCHITECTURE.md` § Observabilidade). */
const PROBE_TIMEOUT_MS = 1000;

@Module({})
export class HealthModule implements OnApplicationShutdown {
  constructor(@Inject(PROBE_SQS_CLIENT) private readonly sqs: SQSClient) {}

  /**
   * @param config - The SQS connection and the queues to probe.
   * @returns The module, with its controller.
   */
  static forRoot(config: Pick<AppConfig, 'sqs'>): DynamicModule {
    const { sqs } = config;
    return {
      module: HealthModule,
      controllers: [HealthController],
      providers: [
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
          inject: [MikroORM, PROBE_SQS_CLIENT],
          useFactory: (orm: MikroORM, client: SQSClient) =>
            new CheckReadiness(
              [
                new DatabaseReadiness(orm.em),
                new SqsQueueReadiness(client, sqs.wagerTransactionsQueue),
                new SqsQueueReadiness(client, sqs.wageringEventsQueue),
              ],
              PROBE_TIMEOUT_MS,
            ),
        },
      ],
    };
  }

  onApplicationShutdown(): void {
    this.sqs.destroy();
  }
}
