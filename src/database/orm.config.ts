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
import { WalletLedgerEntrySchema } from '../wallet/infrastructure/wallet-ledger-entry.schema.ts';
import { WagerTransactionSchema } from '../wagering/infrastructure/wager-transaction.schema.ts';
import { Migration0001Wallets } from '../wallet/infrastructure/migrations/0001-wallets.ts';
import { Migration0002WagerTransactions } from '../wagering/infrastructure/migrations/0002-wager-transactions.ts';
import { Migration0003WalletLedger } from '../wallet/infrastructure/migrations/0003-wallet-ledger.ts';
import { Migration0004WalletIdentity } from '../wallet/infrastructure/migrations/0004-wallet-identity.ts';

/**
 * @param databaseUrl - PostgreSQL connection URL.
 * @returns The ORM options for that database.
 */
export function createOrmConfig(databaseUrl: string): Options {
  return defineConfig({
    clientUrl: databaseUrl,
    entities: [MoneySchema, WalletSchema, WagerTransactionSchema, WalletLedgerEntrySchema],
    extensions: [Migrator],
    migrations: {
      migrationsList: [
        { name: 'Migration0001Wallets', class: Migration0001Wallets },
        { name: 'Migration0002WagerTransactions', class: Migration0002WagerTransactions },
        { name: 'Migration0003WalletLedger', class: Migration0003WalletLedger },
        { name: 'Migration0004WalletIdentity', class: Migration0004WalletIdentity },
      ],
      // Hand-written migrations; the snapshot only serves automatic diffs.
      snapshot: false,
    },
    pool: { min: 0, max: 10 },
    // Absent nullable columns load as `undefined`, as the domain types them.
    forceUndefined: true,
    debug: false,
  });
}
