/**
 * Composition root: builds the Nest application from the configuration. Used
 * by `main.ts` and by the integration tests, which run the app in process.
 *
 * @packageDocumentation
 */
import 'reflect-metadata';
import { Module, type DynamicModule, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { DestinationStream } from 'pino';
import type { AppConfig } from './config.ts';
import { DatabaseModule } from './database/database.module.ts';
import { HealthModule } from './health/interface/health.module.ts';
import { HttpErrorFilter } from './http/http-error.filter.ts';
import { logContextMiddleware } from './http/log-context.middleware.ts';
import { MessagingModule } from './messaging/interface/messaging.module.ts';
import { CONTEXT_LOG, type ContextLog } from './shared/application/context-log.ts';
import {
  LogContextStore,
  PinoContextLog,
  PinoLoggerService,
  createPinoLogger,
} from './shared/infrastructure/pino-logging.ts';
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

@Module({})
class AppModule {
  static forConfig(config: AppConfig, contextLog: ContextLog): DynamicModule {
    return {
      module: AppModule,
      imports: [
        LoggingModule.forRoot(contextLog),
        DatabaseModule.forRoot(config),
        WalletModule,
        WageringModule.forRoot(config),
        MessagingModule.forRoot(config),
        HealthModule.forRoot(config),
      ],
    };
  }
}

export interface CreateAppOptions {
  /** Where the JSON log lines go; stdout by default. The tests read them. */
  logDestination?: DestinationStream;
}

/**
 * @param config - Service configuration.
 * @param options - Where the logs go.
 * @returns The application, initialized but not listening yet.
 */
export async function createApp(config: AppConfig, options: CreateAppOptions = {}): Promise<INestApplication> {
  const logContext = new LogContextStore();
  const logger = createPinoLogger(logContext, options.logDestination);
  const app = await NestFactory.create(AppModule.forConfig(config, new PinoContextLog(logger, logContext)), {
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
