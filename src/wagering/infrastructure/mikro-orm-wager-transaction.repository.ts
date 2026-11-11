/**
 * `WagerTransactionRepository` over a MikroORM entity manager bound to one
 * transaction.
 *
 * @packageDocumentation
 */
import type { EntityManager } from '@mikro-orm/postgresql';
import type { WagerTransactionRepository } from '../application/wager-transaction-repository.ts';
import { WagerTransaction } from '../domain/wager-transaction.ts';

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | null> {
    return this.em.findOne(WagerTransaction, { providerId, idempotencyKey });
  }

  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null> {
    return this.em.findOne(WagerTransaction, { providerId, externalTransactionId });
  }

  add(transaction: WagerTransaction): void {
    this.em.persist(transaction);
  }
}
