/**
 * Looks a wager transaction up. Read only: it locks no wallet and publishes
 * nothing.
 *
 * @packageDocumentation
 */
import type { UnitOfWork } from '../../shared/application/unit-of-work.ts';
import { isUuid } from '../../shared/application/uuid.ts';
import type { WagerTransaction } from '../domain/wager-transaction.ts';
import type { WageringRepositories } from './wager-transaction-repository.ts';

/** No wager transaction answers to the queried id. */
export class WagerTransactionNotFoundError extends Error {
  override readonly name = 'WagerTransactionNotFoundError';

  constructor(description: string) {
    super(`wager transaction ${description} not found`);
  }
}

export class GetWagerTransaction {
  constructor(private readonly unitOfWork: UnitOfWork<WageringRepositories>) {}

  /**
   * @param transactionId - The internal id of the transaction.
   * @returns The transaction.
   * @throws {@link WagerTransactionNotFoundError} If the id is malformed or unknown.
   */
  async byId(transactionId: string): Promise<WagerTransaction> {
    // Transaction ids are UUIDs; anything else cannot exist and never reaches the database.
    if (!isUuid(transactionId)) throw new WagerTransactionNotFoundError(transactionId);
    const transaction = await this.unitOfWork.run(({ transactions }) => transactions.findById(transactionId));
    if (!transaction) throw new WagerTransactionNotFoundError(transactionId);
    return transaction;
  }
}
