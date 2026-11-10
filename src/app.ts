/**
 * Composition root: builds the Nest application from the configuration. Used
 * by `main.ts` and by the integration tests, which run the app in process.
 *
 * @packageDocumentation
 */
import 'reflect-metadata';
import { Module, type DynamicModule, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { AppConfig } from './config.ts';
import { DatabaseModule } from './database/database.module.ts';
import { HttpErrorFilter } from './http/http-error.filter.ts';
import { RejectedSubmissionAudit } from './wagering/interface/rejected-submission.audit.ts';
import { WageringModule } from './wagering/interface/wagering.module.ts';
import { WalletModule } from './wallet/interface/wallet.module.ts';

@Module({})
class AppModule {
  static forConfig(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [DatabaseModule.forRoot(config), WalletModule, WageringModule],
    };
  }
}

/**
 * @param config - Service configuration.
 * @returns The application, initialized but not listening yet.
 */
export async function createApp(config: AppConfig): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.forConfig(config), {
    logger: ['error', 'warn', 'log'],
  });
  app.useGlobalFilters(
    new HttpErrorFilter({
      retryAfterSeconds: config.retryAfterSeconds,
      refusalAudits: [app.get(RejectedSubmissionAudit)],
    }),
  );
  app.enableShutdownHooks();
  return app;
}
