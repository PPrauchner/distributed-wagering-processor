/**
 * Global Nest module of the database: the MikroORM instance and the unit of
 * work bound to it.
 *
 * @packageDocumentation
 */
import { Global, Module, type DynamicModule } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { MikroORM } from '@mikro-orm/postgresql';
import { UNIT_OF_WORK } from '../shared/application/unit-of-work.ts';
import { MikroOrmUnitOfWork } from './mikro-orm-unit-of-work.ts';
import { createOrmConfig } from './orm.config.ts';

@Global()
@Module({})
export class DatabaseModule {
  /**
   * @param databaseUrl - PostgreSQL connection URL.
   * @returns The module, exporting the unit of work.
   */
  static forRoot(databaseUrl: string): DynamicModule {
    return {
      module: DatabaseModule,
      imports: [
        // Every unit of work forks its own entity manager; the request context
        // is not needed, and without it the global manager throws instead of
        // sharing state by accident (ADR 0001).
        MikroOrmModule.forRoot({ ...createOrmConfig(databaseUrl), registerRequestContext: false }),
      ],
      providers: [
        {
          provide: UNIT_OF_WORK,
          inject: [MikroORM],
          useFactory: (orm: MikroORM) => new MikroOrmUnitOfWork(orm.em),
        },
      ],
      exports: [UNIT_OF_WORK],
    };
  }
}
