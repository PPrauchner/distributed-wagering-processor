/**
 * Composition root: builds the Nest application from the configuration. Used
 * by `main.ts` and by the integration tests, which run the app in process.
 *
 * @packageDocumentation
 */
import 'reflect-metadata';
import { Module, type DynamicModule, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { DestinationStream, LevelWithSilent } from 'pino';
import type { AppConfig, SqsConfig } from './config.ts';
import { DatabaseModule } from './database/database.module.ts';
import { HealthModule } from './health/interface/health.module.ts';
import { HttpErrorFilter } from './http/http-error.filter.ts';
import { logContextMiddleware } from './http/log-context.middleware.ts';
import {
  MessagingModule,
  type MessagingModuleOptions,
  type SqsConnectionOptions,
} from './messaging/interface/messaging.module.ts';
import { CONTEXT_LOG, type ContextLog } from './shared/application/context-log.ts';
import { PROVIDER_IDENTITY, type ProviderIdentity } from './shared/application/provider-identity.ts';
import { DeclaredProviderIdentity } from './shared/infrastructure/declared-provider-identity.ts';
import {
  LogContextStore,
  PinoContextLog,
  PinoLoggerService,
  createPinoLogger,
} from './shared/infrastructure/pino-logging.ts';
import type { Crash } from './shared/infrastructure/crash-fault-injector.ts';
import { RecordOpening } from './wagering/application/record-opening.ts';
import { RejectedSubmissionAudit } from './wagering/interface/rejected-submission.audit.ts';
import { WageringModule } from './wagering/interface/wagering.module.ts';
import { WalletModule } from './wallet/interface/wallet.module.ts';

/** Global: offers the use cases' `ContextLog` by token. */
@Module({})
class LoggingModule {
  static forRoot(contextLog: ContextLog): DynamicModule {
    return {
      module: LoggingModule,
      global: true,
      providers: [{ provide: CONTEXT_LOG, useValue: contextLog }],
      exports: [CONTEXT_LOG],
    };
  }
}

/** Global: offers the guard's `ProviderIdentity` by token; the no-op by default. */
@Module({})
class ProviderIdentityModule {
  static forRoot(identity: ProviderIdentity): DynamicModule {
    return {
      module: ProviderIdentityModule,
      global: true,
      providers: [{ provide: PROVIDER_IDENTITY, useValue: identity }],
      exports: [PROVIDER_IDENTITY],
    };
  }
}

function sqsConnectionOf({ endpoint, region, accessKeyId, secretAccessKey }: SqsConfig): SqsConnectionOptions {
  return { endpoint, region, accessKeyId, secretAccessKey };
}

function queuesOf(sqs: SqsConfig): MessagingModuleOptions['queues'] {
  return {
    wagerTransactions: sqs.wagerTransactionsQueue,
    wagerTransactionsDlq: sqs.wagerTransactionsDlq,
    wageringEvents: sqs.wageringEventsQueue,
  };
}

/** Translates the configuration to each module's options: no module imports it. */
@Module({})
class AppModule {
  static forConfig(
    config: AppConfig,
    contextLog: ContextLog,
    identity: ProviderIdentity,
    crash?: Crash,
  ): DynamicModule {
    return {
      module: AppModule,
      imports: [
        LoggingModule.forRoot(contextLog),
        ProviderIdentityModule.forRoot(identity),
        DatabaseModule.forRoot(config),
        // The wallet's opening is recorded by wagering: the root binds the two ends.
        WalletModule.forRoot({ openingRecorder: new RecordOpening(() => Bun.randomUUIDv7()) }),
        WageringModule.forRoot({
          wagerTransactionsConsumer: config.wagerTransactionsConsumer,
          pendingReferences: config.pendingReferences,
          faultPoints: config.faultPoints,
          crash,
        }),
        MessagingModule.forRoot({
          sqs: sqsConnectionOf(config.sqs),
          queues: queuesOf(config.sqs),
          inputQueue: {
            waitTimeSeconds: config.wagerTransactionsConsumer.waitTimeSeconds,
            batchSize: config.wagerTransactionsConsumer.batchSize,
            visibilityTimeoutSeconds: config.wagerTransactionsConsumer.visibilityTimeoutSeconds,
          },
          outboxPublisher: config.outboxPublisher,
        }),
        HealthModule.forRoot({ sqs: sqsConnectionOf(config.sqs), queues: queuesOf(config.sqs) }),
      ],
    };
  }
}

export interface CreateAppOptions {
  /** Where the JSON log lines go; stdout by default. The tests read them. */
  logDestination?: DestinationStream;
  /**
   * The log's level, over the configuration's: a test that reads the lines
   * fixes its own, whatever `LOG_LEVEL` the suite runs with.
   */
  logLevel?: LevelWithSilent;
  /**
   * How the process dies at an enabled crash fault point. `main.ts` gives the
   * real death, `SIGKILL`; in process — the integration tests — the default
   * `SimulatedCrashError` keeps the test runner alive.
   */
  crash?: Crash;
  /**
   * Who the requests are authenticated as; by default, the no-op that trusts
   * the provider the request declares. The tests swap in a fake one.
   */
  providerIdentity?: ProviderIdentity;
}

/**
 * @param config - Service configuration.
 * @param options - Where the logs go and at which level, how a crash fault
 *   point dies, and who the requests are authenticated as.
 * @returns The application, initialized but not listening yet.
 */
export async function createApp(config: AppConfig, options: CreateAppOptions = {}): Promise<INestApplication> {
  const logContext = new LogContextStore();
  const logger = createPinoLogger(logContext, options.logDestination, options.logLevel ?? config.logLevel);
  const appModule = AppModule.forConfig(
    config,
    new PinoContextLog(logger, logContext),
    options.providerIdentity ?? new DeclaredProviderIdentity(),
    options.crash,
  );
  const app = await NestFactory.create(appModule, {
    logger: new PinoLoggerService(logger),
  });
  app.use(logContextMiddleware(logContext));
  app.useGlobalFilters(
    new HttpErrorFilter({
      retryAfterSeconds: config.retryAfterSeconds,
      refusalAudits: [app.get(RejectedSubmissionAudit)],
    }),
  );
  app.enableShutdownHooks();
  return app;
}
