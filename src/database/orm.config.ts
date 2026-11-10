/**
 * MikroORM configuration. Entities and migrations are registered explicitly:
 * glob discovery and the MikroORM CLI fail or require Node under Bun (ADR 0001).
 *
 * @packageDocumentation
 */
import { defineConfig, type Options } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { MoneySchema } from '../shared/infrastructure/money.schema.ts';
import { WalletSchema } from '../wallet/infrastructure/wallet.schema.ts';
import { Migration0001Wallets } from '../wallet/infrastructure/migrations/0001-wallets.ts';

/**
 * @param databaseUrl - PostgreSQL connection URL.
 * @returns The ORM options for that database.
 */
export function createOrmConfig(databaseUrl: string): Options {
  return defineConfig({
    clientUrl: databaseUrl,
    entities: [MoneySchema, WalletSchema],
    extensions: [Migrator],
    migrations: {
      migrationsList: [{ name: 'Migration0001Wallets', class: Migration0001Wallets }],
      // Hand-written migrations; the snapshot only serves automatic diffs.
      snapshot: false,
    },
    pool: { min: 0, max: 10 },
    debug: false,
  });
}
