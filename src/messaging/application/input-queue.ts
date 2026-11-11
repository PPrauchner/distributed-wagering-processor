/**
 * `InputQueue` port: how a consumer receives the messages of its input queue
 * and acknowledges them — the `ack` that removes a message for good, only
 * after the outcome it led to committed — or hands one back, visible again
 * after a delay of its choosing. Implemented over SQS; nothing here knows the
 * broker.
 *
 * @packageDocumentation
 */

/** A message as the queue delivered it. */
export interface ReceivedMessage {
  body: string;
  /** The message attributes with a string value, by name. */
  attributes: Readonly<Record<string, string>>;
  /**
   * The broker's id of this queue message: the same on each redelivery of
   * it, another when the same body is sent again — by a DLQ redrive, say.
   */
  deliveryId: string;
  /** What acknowledging this delivery takes; opaque to the consumer. */
  receipt: string;
  /** How many times the message was received, this delivery included: 1 on the first. */
  receiveCount: number;
  /**
   * The FIFO group the broker delivered it in — its `MessageGroupId` —, if
   * any: the broker keeps the order within a group, and so must the consumer.
   */
  groupId?: string;
}

export interface InputQueue {
  /**
   * Waits for a batch — long polling — and hides what it returns from the
   * other consumers for the visibility timeout.
   *
   * @param signal - Cuts the wait short: it then resolves empty, and whatever
   *   the broker had already handed over reappears once its visibility expires.
   * @returns The messages received; empty when the wait ended with none.
   */
  receive(signal?: AbortSignal): Promise<ReceivedMessage[]>;
  /** Removes the message from the queue: it will not be delivered again. */
  acknowledge(message: ReceivedMessage): Promise<void>;
  /**
   * Hands the delivery back: the message is received again once `seconds`
   * pass — at once with 0.
   *
   * @param message - The delivery to hand back.
   * @param seconds - How long it stays invisible from now.
   */
  changeVisibility(message: ReceivedMessage, seconds: number): Promise<void>;
}

/** Injection token of the input queue of the wager transactions. */
export const WAGER_TRANSACTIONS_QUEUE = Symbol('WagerTransactionsQueue');
