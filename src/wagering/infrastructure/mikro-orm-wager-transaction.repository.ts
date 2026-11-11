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

  async isReversed(referenceTransactionId: string): Promise<boolean> {
    // The same predicate as the single reversal index.
    const rows: unknown[] = await this.em.execute(
      `select 1 from wager_transactions
        where reference_transaction_id = ? and status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK')
        limit 1`,
      [referenceTransactionId],
    );
    return rows.length > 0;
  }

  add(transaction: WagerTransaction): void {
    this.em.persist(transaction);
  }
}
