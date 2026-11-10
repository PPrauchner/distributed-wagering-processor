/**
 * `EventPublisher` port: how the outbox publisher hands a batch of messages to
 * the event queue. Implemented over SQS; nothing here knows the broker.
 *
 * @packageDocumentation
 */
import type { OutboxMessage } from '../domain/outbox-message.ts';

/** A message the queue did not accept, and why. */
export interface PublishFailure {
  id: string;
  reason: string;
}

/** The outcome of each message of a batch, by message id. */
export interface PublishResult {
  published: string[];
  failed: PublishFailure[];
}

export interface EventPublisher {
  /**
   * Sends the messages, each grouped by its wallet and deduplicated by its id.
   *
   * @param messages - Up to 10 messages.
   * @returns Which were accepted by the queue and which were not.
   * @throws {@link Error} If the batch could not be sent at all.
   */
  publish(messages: readonly OutboxMessage[]): Promise<PublishResult>;
}
