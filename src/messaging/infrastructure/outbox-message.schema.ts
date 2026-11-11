/**
 * `OutboxMessage` mapping, kept out of the domain. Private fields point at
 * their public getters (`accessor`).
 *
 * @packageDocumentation
 */
import { defineEntity, p, type EntityCtor } from '@mikro-orm/core';
import { OutboxMessage } from '../domain/outbox-message.ts';

// Type-only cast for the private constructor; see `money.schema.ts`.
const OutboxMessageClass = OutboxMessage as unknown as EntityCtor<OutboxMessage>;

export const OutboxMessageSchema = defineEntity({
  class: OutboxMessageClass,
  tableName: 'outbox_messages',
  properties: {
    id: p.uuid().primary(),
    aggregateId: p.text(),
    eventType: p.text(),
    walletId: p.uuid(),
    payload: p.json<Readonly<Record<string, unknown>>>(),
    occurredAt: p.datetime(),
    _attempts: p.integer().accessor('attempts'),
    _nextAttemptAt: p.datetime().nullable().accessor('nextAttemptAt'),
    _publishedAt: p.datetime().nullable().accessor('publishedAt'),
  },
});
