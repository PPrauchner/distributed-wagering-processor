/**
 * `OutboxRepository` port: the use cases write their events in their own unit
 * of work, and the publisher claims, marks and reschedules them, each in a
 * short unit of work of its own that never touches a wallet (ADR 0002).
 *
 * @packageDocumentation
 */
import type { OutboxMessage } from '../domain/outbox-message.ts';

export interface OutboxRepository {
  /** Registers a new message; it is written when the unit of work commits, with the change. */
  add(message: OutboxMessage): void;
  /**
   * Claims up to `limit` due messages by lease: `FOR UPDATE SKIP LOCKED`, and
   * their next attempt pushed to the database's `now()` plus the lease, so no
   * other publisher takes them until it expires.
   *
   * @param limit - The batch size.
   * @param leaseMs - How long the claim lasts.
   * @returns The claimed messages.
   */
  claimDue(limit: number, leaseMs: number): Promise<OutboxMessage[]>;
  /** Records the message's `publishedAt`. */
  markPublished(message: OutboxMessage): Promise<void>;
  /** Records the message's attempts and next attempt. */
  reschedule(message: OutboxMessage): Promise<void>;
}

export interface OutboxRepositories {
  outbox: OutboxRepository;
}
