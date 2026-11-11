/**
 * `WagerTransactionRepository` port and the repositories the wagering use cases
 * need from a unit of work.
 *
 * @packageDocumentation
 */
import type { WagerTransaction } from '../domain/wager-transaction.ts';

export interface WagerTransactionRepository {
  findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | null>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null>;
  /**
   * Whether a `REFUND` or `ROLLBACK` already `PROCESSED` undid the transaction.
   * Read under its wallet lock, which serializes every undo of it.
   *
   * @param referenceTransactionId - The internal id of the cited transaction.
   */
  isReversed(referenceTransactionId: string): Promise<boolean>;
  /** Registers a new transaction; it is written when the unit of work commits. */
  add(transaction: WagerTransaction): void;
}

export interface WageringRepositories {
  transactions: WagerTransactionRepository;
}
