/**
 * `WalletLedgerRepository` over a MikroORM entity manager bound to one
 * transaction. Entries are only ever added: the ledger is immutable.
 *
 * @packageDocumentation
 */
import type { EntityManager } from '@mikro-orm/postgresql';
import type { LedgerSnapshot, WalletLedgerRepository } from '../application/wallet-repository.ts';
import { WalletLedgerEntry } from '../domain/wallet-ledger-entry.ts';
import { reconciliationQuery, type ReconciliationRow } from './reconciliation-query.ts';

const RECONCILIATION_QUERY = reconciliationQuery('?');

export class MikroOrmWalletLedgerRepository implements WalletLedgerRepository {
  constructor(private readonly em: EntityManager) {}

  add(entry: WalletLedgerEntry): void {
    this.em.persist(entry);
  }

  findPage(walletId: string, afterVersion: number, limit: number): Promise<WalletLedgerEntry[]> {
    return this.em.find(
      WalletLedgerEntry,
      { walletId, walletVersion: { $gt: afterVersion } },
      { orderBy: { walletVersion: 'asc' }, limit },
    );
  }

  async reconcile(walletId: string): Promise<LedgerSnapshot | null> {
    const [row]: ReconciliationRow[] = await this.em.execute(RECONCILIATION_QUERY, [walletId]);
    if (!row) return null;
    return {
      walletId: row.wallet_id,
      currency: row.currency,
      storedBalance: row.stored_balance,
      calculatedBalance: row.calculated_balance,
      difference: row.difference,
      checkedEntries: row.checked_entries,
      versionGaps: row.version_gaps,
    };
  }
}
