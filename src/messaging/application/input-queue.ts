/**
 * `InputQueue` port: how a consumer receives the messages of its input queue
 * and acknowledges them — the `ack` that removes a message for good, only
 * after the outcome it led to committed. Implemented over SQS; nothing here
 * knows the broker.
 *
 * @packageDocumentation
 */

/** A message as the queue delivered it. */
export interface ReceivedMessage {
  body: string;
  /** The message attributes with a string value, by name. */
  attributes: Readonly<Record<string, string>>;
  /** What acknowledging this delivery takes; opaque to the consumer. */
  receipt: string;
}

export interface InputQueue {
  /**
   * Waits for a batch — long polling — and hides what it returns from the
   * other consumers for the visibility timeout.
   *
   * @returns The messages received; empty when the wait ended with none.
   */
  receive(): Promise<ReceivedMessage[]>;
  /** Removes the message from the queue: it will not be delivered again. */
  acknowledge(message: ReceivedMessage): Promise<void>;
}

/** Injection token of the input queue of the wager transactions. */
export const WAGER_TRANSACTIONS_QUEUE = Symbol('WagerTransactionsQueue');
