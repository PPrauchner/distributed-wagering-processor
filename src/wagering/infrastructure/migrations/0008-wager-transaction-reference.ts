/**
 * The reference of a wager transaction, guaranteed by the schema
 * (`ARCHITECTURE.md` § Invariantes no schema):
 *
 * - `reference_transaction_id` is a foreign key into the table itself, so a
 *   resolved reference always exists;
 * - `failure_message` keeps what the failure code alone does not say — the
 *   divergent field of a `REFERENCE_MISMATCH` — so the replay answers it too;
 *   it only goes with a failure code.
 *
 * @packageDocumentation
 */
import { Migration } from '@mikro-orm/migrations';

export class Migration0008WagerTransactionReference extends Migration {
  override name = 'Migration0008WagerTransactionReference';

  override up(): void {
    this.addSql(`
      alter table wager_transactions
        add column failure_message text,
        add constraint wager_transactions_reference_fk
          foreign key (reference_transaction_id) references wager_transactions (id),
        add constraint wager_transactions_failure_message check (
          failure_message is null or failure_code is not null
        );
    `);
  }

  override down(): void {
    this.addSql(`
      alter table wager_transactions
        drop constraint wager_transactions_failure_message,
        drop constraint wager_transactions_reference_fk,
        drop column failure_message;
    `);
  }
}
