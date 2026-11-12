/**
 * `WagerTransactionRepository` port and the repositories the wagering use cases
 * need from a unit of work.
 *
 * @packageDocumentation
 */
import type { WagerTransaction } from '../domain/wager-transaction.ts';

/** A pending reference the worker claimed: the transaction, and the wallet to lock first. */
export interface PendingReferenceClaim {
  transactionId: string;
  walletId: string;
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | null>;
  /**
   * Locks the transaction's row and reads it as last committed: a worker that
   * waited for another one sees what that one recorded. Waits no longer than
   * the wallet's `lock_timeout` (ADR 0002).
   */
  findByIdForUpdate(id: string): Promise<WagerTransaction | null>;
  findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | null>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null>;
  /**
   * Whether a `REFUND` or `ROLLBACK` already `PROCESSED` undid the transaction.
   * Read under its wallet lock, which serializes every undo of it.
   *
   * @param referenceTransactionId - The internal id of the cited transaction.
   */
  isReversed(referenceTransactionId: string): Promise<boolean>;
  /**
   * Claims up to `limit` due pending references by lease: `FOR UPDATE SKIP
   * LOCKED`, and their next attempt pushed to the database's `now()` plus the
   * lease, so no other worker takes them until it expires.
   *
   * @param limit - The batch size.
   * @param leaseMs - How long the claim lasts.
   * @returns The claimed transactions, the longest due first.
   */
  claimDuePendingReferences(limit: number, leaseMs: number): Promise<PendingReferenceClaim[]>;
  /**
   * Whether the transaction's wait is over: its creation plus the TTL is past,
   * on the database clock.
   *
   * @param transactionId - The pending reference.
   * @param ttlMs - How long it waits from its creation.
   */
  isReferenceWaitOver(transactionId: string, ttlMs: number): Promise<boolean>;
  /** Registers a new transaction; it is written when the unit of work commits. */
  add(transaction: WagerTransaction): void;
}

export interface WageringRepositories {
  transactions: WagerTransactionRepository;
}
