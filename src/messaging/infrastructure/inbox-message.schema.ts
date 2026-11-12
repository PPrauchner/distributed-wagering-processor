/**
 * `InboxMessage` mapping, kept out of the domain: a composite primary key
 * `(consumer_name, message_id)`. Private fields point at their public getters
 * (`accessor`).
 *
 * @packageDocumentation
 */
import { defineEntity, p, type EntityCtor } from '@mikro-orm/core';
import { InboxMessage } from '../domain/inbox-message.ts';

// Type-only cast for the private constructor; see `money.schema.ts`.
const InboxMessageClass = InboxMessage as unknown as EntityCtor<InboxMessage>;

export const InboxMessageSchema = defineEntity({
  class: InboxMessageClass,
  tableName: 'inbox_messages',
  properties: {
    consumerName: p.text().primary(),
    messageId: p.text().primary(),
    payloadHash: p.text(),
    receivedAt: p.datetime(),
    _processedAt: p.datetime().nullable().accessor('processedAt'),
  },
});
