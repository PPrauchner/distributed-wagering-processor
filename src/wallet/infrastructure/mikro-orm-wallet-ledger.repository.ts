/**
 * `WalletLedgerRepository` over a MikroORM entity manager bound to one
 * transaction. Entries are only ever added: the ledger is immutable.
 *
 * @packageDocumentation
 */
import type { EntityManager } from '@mikro-orm/postgresql';
import type { WalletLedgerRepository } from '../application/wallet-repository.ts';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry.ts';

export class MikroOrmWalletLedgerRepository implements WalletLedgerRepository {
  constructor(private readonly em: EntityManager) {}

  add(entry: WalletLedgerEntry): void {
    this.em.persist(entry);
  }
}
