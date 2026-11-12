/**
 * `OutboxRepository` over a MikroORM entity manager bound to one transaction.
 * The claim is one statement: the due rows are locked with `SKIP LOCKED` — a
 * row another publisher is claiming is skipped, not waited for — and leased on
 * the database clock.
 *
 * @packageDocumentation
 */
import type { EntityManager } from '@mikro-orm/postgresql';
import type { OutboxRepository } from '../application/outbox-repository.ts';
import { OutboxMessage } from '../domain/outbox-message.ts';

export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  add(message: OutboxMessage): void {
    this.em.persist(message);
  }

  async claimDue(limit: number, leaseMs: number): Promise<OutboxMessage[]> {
    const claimed: { id: string }[] = await this.em.execute(
      `update outbox_messages
          set next_attempt_at = now() + make_interval(secs => ?)
        where id in (
          select id from outbox_messages
           where published_at is null and (next_attempt_at is null or next_attempt_at <= now())
           order by next_attempt_at nulls first, occurred_at
           limit ?
           for update skip locked)
       returning id`,
      [leaseMs / 1000, limit],
    );
    if (claimed.length === 0) return [];
    // Read through the mapping, in the same SQL transaction: the lease is visible.
    const messages = await this.em.find(OutboxMessage, { id: { $in: claimed.map((row) => row.id) } });
    return messages.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  }

  async markPublished(message: OutboxMessage): Promise<void> {
    if (message.publishedAt === undefined) throw new Error(`outbox message ${message.id} is not published`);
    await this.em.execute('update outbox_messages set published_at = ? where id = ? and published_at is null', [
      message.publishedAt,
      message.id,
    ]);
  }

  async reschedule(message: OutboxMessage): Promise<void> {
    await this.em.execute(
      'update outbox_messages set attempts = ?, next_attempt_at = ? where id = ? and published_at is null',
      [message.attempts, message.nextAttemptAt ?? null, message.id],
    );
  }
}
