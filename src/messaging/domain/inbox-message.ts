/**
 * `InboxMessage` (§6.5): a queue message a consumer received, identified by
 * the consumer's name and the envelope's `messageId` — never the broker's
 * own id. Recorded in the same SQL transaction as the outcome it led to, so a
 * redelivery of it is recognized by the primary key, not by memory.
 *
 * @packageDocumentation
 */

export interface ReceiveInboxProps {
  consumerName: string;
  messageId: string;
  /** The fingerprint of the message's `data`, by the payload hash function. */
  payloadHash: string;
  receivedAt: Date;
}

/** Persisted state of a message, rebuilt as is by {@link InboxMessage.rehydrate}. */
export interface InboxMessageState extends ReceiveInboxProps {
  processedAt?: Date;
}

/** An inbox message without the identity the primary key needs. */
export class InvalidInboxMessageError extends Error {
  override readonly name = 'InvalidInboxMessageError';
}

export class InboxMessage {
  // Only assigns parameters: the ORM's metadata discovery calls the constructor
  // with no arguments (ADR 0001).
  private constructor(
    readonly consumerName: string,
    readonly messageId: string,
    readonly payloadHash: string,
    readonly receivedAt: Date,
    private _processedAt?: Date,
  ) {}

  /**
   * @param props - Who received it, its envelope id, its fingerprint and when.
   * @returns The message, not processed yet.
   * @throws {@link InvalidInboxMessageError} If the consumer name or the message id is empty.
   */
  static receive(props: ReceiveInboxProps): InboxMessage {
    if (props.consumerName.length === 0) throw new InvalidInboxMessageError('consumerName must not be empty');
    if (props.messageId.length === 0) throw new InvalidInboxMessageError('messageId must not be empty');
    return new InboxMessage(props.consumerName, props.messageId, props.payloadHash, props.receivedAt);
  }

  /** Rebuilds persisted state. */
  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(state.consumerName, state.messageId, state.payloadHash, state.receivedAt, state.processedAt);
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  /** The outcome it led to was recorded. A message already processed keeps its first time. */
  markProcessed(at: Date): void {
    if (!this.isProcessed()) this._processedAt = at;
  }
}
