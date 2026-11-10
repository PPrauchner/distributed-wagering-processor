/**
 * `WagerTransactionRepository` over a MikroORM entity manager bound to one
 * transaction.
 *
 * @packageDocumentation
 */
import type { EntityManager } from '@mikro-orm/postgresql';
import type { WagerTransactionRepository } from '../application/wager-transaction-repository.ts';
import type { WagerTransaction } from '../domain/wager-transaction.ts';

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  add(transaction: WagerTransaction): void {
    this.em.persist(transaction);
  }
}
