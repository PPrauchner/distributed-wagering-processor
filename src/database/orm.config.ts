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
import { RejectedSubmissionSchema } from '../wagering/infrastructure/rejected-submission.schema.ts';
import { OutboxMessageSchema } from '../messaging/infrastructure/outbox-message.schema.ts';
import { InboxMessageSchema } from '../messaging/infrastructure/inbox-message.schema.ts';
import { Migration0001Wallets } from '../wallet/infrastructure/migrations/0001-wallets.ts';
import { Migration0002WagerTransactions } from '../wagering/infrastructure/migrations/0002-wager-transactions.ts';
import { Migration0003WalletLedger } from '../wallet/infrastructure/migrations/0003-wallet-ledger.ts';
import { Migration0004WalletIdentity } from '../wallet/infrastructure/migrations/0004-wallet-identity.ts';
import { Migration0005WagerTransactionInvariants } from '../wagering/infrastructure/migrations/0005-wager-transaction-invariants.ts';
import { Migration0006RejectedSubmissions } from '../wagering/infrastructure/migrations/0006-rejected-submissions.ts';
import { Migration0007OutboxMessages } from '../messaging/infrastructure/migrations/0007-outbox-messages.ts';
import { Migration0008WagerTransactionReference } from '../wagering/infrastructure/migrations/0008-wager-transaction-reference.ts';
import { Migration0009WagerTransactionSingleReversal } from '../wagering/infrastructure/migrations/0009-wager-transaction-single-reversal.ts';
import { Migration0010InboxMessages } from '../messaging/infrastructure/migrations/0010-inbox-messages.ts';
import { Migration0011WagerTransactionReferenceSchedule } from '../wagering/infrastructure/migrations/0011-wager-transaction-reference-schedule.ts';
import { Migration0012WalletCreationIdempotency } from '../wallet/infrastructure/migrations/0012-wallet-creation-idempotency.ts';
import { Migration0013WalletLedgerTransactionCoherence } from '../wallet/infrastructure/migrations/0013-wallet-ledger-transaction-coherence.ts';
import { Migration0014WalletLedgerTransactionFkDeferred } from '../wallet/infrastructure/migrations/0014-wallet-ledger-transaction-fk-deferred.ts';

/**
 * @param databaseUrl - PostgreSQL connection URL.
 * @returns The ORM options for that database.
 */
export function createOrmConfig(databaseUrl: string): Options {
  return defineConfig({
    clientUrl: databaseUrl,
    entities: [
      MoneySchema,
      WalletSchema,
      WagerTransactionSchema,
      WalletLedgerEntrySchema,
      RejectedSubmissionSchema,
      OutboxMessageSchema,
      InboxMessageSchema,
    ],
    extensions: [Migrator],
    migrations: {
      migrationsList: [
        { name: 'Migration0001Wallets', class: Migration0001Wallets },
        { name: 'Migration0002WagerTransactions', class: Migration0002WagerTransactions },
        { name: 'Migration0003WalletLedger', class: Migration0003WalletLedger },
        { name: 'Migration0004WalletIdentity', class: Migration0004WalletIdentity },
        { name: 'Migration0005WagerTransactionInvariants', class: Migration0005WagerTransactionInvariants },
        { name: 'Migration0006RejectedSubmissions', class: Migration0006RejectedSubmissions },
        { name: 'Migration0007OutboxMessages', class: Migration0007OutboxMessages },
        { name: 'Migration0008WagerTransactionReference', class: Migration0008WagerTransactionReference },
        { name: 'Migration0009WagerTransactionSingleReversal', class: Migration0009WagerTransactionSingleReversal },
        { name: 'Migration0010InboxMessages', class: Migration0010InboxMessages },
        {
          name: 'Migration0011WagerTransactionReferenceSchedule',
          class: Migration0011WagerTransactionReferenceSchedule,
        },
        { name: 'Migration0012WalletCreationIdempotency', class: Migration0012WalletCreationIdempotency },
        {
          name: 'Migration0013WalletLedgerTransactionCoherence',
          class: Migration0013WalletLedgerTransactionCoherence,
        },
        {
          name: 'Migration0014WalletLedgerTransactionFkDeferred',
          class: Migration0014WalletLedgerTransactionFkDeferred,
        },
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
