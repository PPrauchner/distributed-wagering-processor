/**
 * `IntegrationEvent`: the envelope of §11 — a fact published outside the
 * service once the change that produced it is committed. Abstract: each event
 * is a concrete subclass, with its `eventType` and `version` in the type.
 *
 * @packageDocumentation
 */

/** What every event of one outcome shares: where it came from. */
export interface EventContext {
  correlationId: string;
  /** The id of what caused the event — the transaction, for a transaction's outcome. */
  causationId?: string;
}

export interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: T;
}

/** The serialized envelope, as the outbox stores it and the queue carries it. */
export interface IntegrationEventJson<T> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  /** ISO-8601. */
  occurredAt: string;
  version: number;
  data: T;
}

/** The `data` of an event that belongs to one wallet: its `MessageGroupId`. */
export interface WalletScopedData {
  walletId: string;
}

export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = props.occurredAt;
    this.data = props.data;
  }

  /** The envelope serialized as the outbox payload. */
  toJSON(): IntegrationEventJson<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      causationId: this.causationId,
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data as T,
    };
  }
}
