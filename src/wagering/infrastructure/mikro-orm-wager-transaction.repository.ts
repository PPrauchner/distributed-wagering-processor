/**
 * `WagerTransactionRepository` over a MikroORM entity manager bound to one
 * transaction.
 *
 * @packageDocumentation
 */
import type { EntityManager } from '@mikro-orm/postgresql';
import type {
  PendingReferenceClaim,
  WagerTransactionRepository,
} from '../application/wager-transaction-repository.ts';
import { WagerTransaction } from '../domain/wager-transaction.ts';

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  findById(id: string): Promise<WagerTransaction | null> {
    return this.em.findOne(WagerTransaction, { id });
  }

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

  async claimDuePendingReferences(limit: number, leaseMs: number): Promise<PendingReferenceClaim[]> {
    // The predicate of the partial index on next_attempt_at.
    const claimed: { id: string; wallet_id: string; next_attempt_at: Date }[] = await this.em.execute(
      `update wager_transactions as claimed
          set next_attempt_at = now() + make_interval(secs => ?)
         from (
           select id, next_attempt_at as due_at from wager_transactions
            where status = 'PENDING_REFERENCE' and next_attempt_at <= now()
            order by next_attempt_at
            limit ?
            for update skip locked) as due
        where claimed.id = due.id
       returning claimed.id, claimed.wallet_id, due.due_at as next_attempt_at`,
      [leaseMs / 1000, limit],
    );
    return claimed
      .sort((a, b) => new Date(a.next_attempt_at).getTime() - new Date(b.next_attempt_at).getTime())
      .map((row) => ({ transactionId: row.id, walletId: row.wallet_id }));
  }

  async isReferenceWaitOver(transactionId: string, ttlMs: number): Promise<boolean> {
    const rows: { over: boolean }[] = await this.em.execute(
      'select created_at + make_interval(secs => ?) <= now() as over from wager_transactions where id = ?',
      [ttlMs / 1000, transactionId],
    );
    return rows[0]?.over === true;
  }

  add(transaction: WagerTransaction): void {
    this.em.persist(transaction);
  }
}
