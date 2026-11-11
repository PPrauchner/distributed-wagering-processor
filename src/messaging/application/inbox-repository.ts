/**
 * `InboxRepository` port: a use case fed by a queue records the message it
 * received in its own unit of work, with the outcome — and a redelivery is
 * refused by the inbox's primary key `(consumer_name, message_id)` when the
 * unit of work commits, never by memory (`ARCHITECTURE.md` § Mensageria).
 *
 * @packageDocumentation
 */
import type { InboxMessage } from '../domain/inbox-message.ts';

/** What a consumer tells a use case about the message it is processing. */
export interface InboxEntry {
  consumerName: string;
  /** The envelope's `messageId`, not the broker's. */
  messageId: string;
  /** The payload hash of the envelope's `data`. */
  payloadHash: string;
}

export interface InboxRepository {
  /** Registers a received message; it is written when the unit of work commits, with the outcome. */
  add(message: InboxMessage): void;
}

export interface InboxRepositories {
  inbox: InboxRepository;
}

/**
 * The inbox already holds the message: it was processed before, and its
 * outcome committed. The unit of work rolled back; acknowledge it with no effect.
 */
export class InboxRedeliveryError extends Error {
  override readonly name = 'InboxRedeliveryError';
}
