/**
 * `InboxRepository` over a MikroORM entity manager bound to one transaction.
 *
 * @packageDocumentation
 */
import type { EntityManager } from '@mikro-orm/postgresql';
import type { InboxRepository } from '../application/inbox-repository.ts';
import { InboxMessage } from '../domain/inbox-message.ts';

export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  add(message: InboxMessage): void {
    this.em.persist(message);
  }

  find(consumerName: string, messageId: string): Promise<InboxMessage | null> {
    return this.em.findOne(InboxMessage, { consumerName, messageId });
  }
}
