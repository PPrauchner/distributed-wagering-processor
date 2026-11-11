/**
 * A reference is undone once, by any kind (`ARCHITECTURE.md` § Reembolso e
 * reversão): a partial unique index on `reference_transaction_id` among the
 * `PROCESSED` refunds and rollbacks. The wallet lock already serializes a second
 * undo, which the domain rejects; a violation here is a bug, classified
 * permanent.
 *
 * @packageDocumentation
 */
import { Migration } from '@mikro-orm/migrations';

export class Migration0009WagerTransactionSingleReversal extends Migration {
  override name = 'Migration0009WagerTransactionSingleReversal';

  override up(): void {
    this.addSql(`
      create unique index wager_transactions_single_reversal_unique
        on wager_transactions (reference_transaction_id)
        where status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK');
    `);
  }

  override down(): void {
    this.addSql('drop index wager_transactions_single_reversal_unique;');
  }
}
