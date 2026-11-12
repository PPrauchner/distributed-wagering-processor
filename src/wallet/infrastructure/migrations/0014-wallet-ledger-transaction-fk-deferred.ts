/**
 * Checks the foreign keys of a ledger entry to its transaction at commit
 * (`ARCHITECTURE.md` § Organização do código): the ORM maps the entry's
 * `transaction_id` as a plain column, so `wallet` does not depend on the
 * mapping of `wagering`, and the flush no longer orders the transaction's
 * insert before the entry's. The guarantee is the same — no entry commits
 * without its transaction, of the same terms.
 *
 * @packageDocumentation
 */
import { Migration } from '@mikro-orm/migrations';

const TRANSACTION_FKS = ['wallet_ledger_entries_transaction_fk', 'wallet_ledger_entries_transaction_terms_fk'];

export class Migration0014WalletLedgerTransactionFkDeferred extends Migration {
  override name = 'Migration0014WalletLedgerTransactionFkDeferred';

  override up(): void {
    for (const fk of TRANSACTION_FKS) {
      this.addSql(`alter table wallet_ledger_entries alter constraint ${fk} deferrable initially deferred;`);
    }
  }

  override down(): void {
    for (const fk of TRANSACTION_FKS) {
      this.addSql(`alter table wallet_ledger_entries alter constraint ${fk} not deferrable;`);
    }
  }
}
