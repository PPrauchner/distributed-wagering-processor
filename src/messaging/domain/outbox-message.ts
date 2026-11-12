/**
 * `OutboxMessage` (§6.5): an integration event recorded with the change that
 * produced it, waiting to be published. Its id is the event's id, stable from
 * the enqueue on: every resend of it carries the same `eventId`. It keeps the
 * event's wallet, the `MessageGroupId` of the publication.
 *
 * @packageDocumentation
 */
import type { IntegrationEvent, WalletScopedData } from '../../shared/domain/integration-event.ts';

/** Persisted state of a message, rebuilt as is by {@link OutboxMessage.rehydrate}. */
export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  walletId: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

/** How long a failed publication waits: `min(base × 2^attempts, max)`, ±20% jitter. */
export interface RetryBackoff {
  baseMs: number;
  maxMs: number;
  /** A number in [0, 1); `Math.random` by default. */
  random?: () => number;
}

export const DEFAULT_RETRY_BACKOFF: RetryBackoff = { baseMs: 1000, maxMs: 5 * 60_000 };

/**
 * From this many failed attempts on, a message is stuck: its 10th failure
 * raises an alert and it counts in `outbox_stuck_messages`. It is still retried.
 */
export const STUCK_ATTEMPTS = 10;

const JITTER = 0.2;

export class OutboxMessage {
  // Only assigns parameters: the ORM's metadata discovery calls the constructor
  // with no arguments (ADR 0001).
  private constructor(
    readonly id: string,
    readonly aggregateId: string,
    readonly eventType: string,
    readonly walletId: string,
    readonly payload: Readonly<Record<string, unknown>>,
    readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  /**
   * @param event - An event that belongs to one wallet.
   * @returns The message holding its envelope, due at once.
   */
  static enqueue(event: IntegrationEvent<WalletScopedData>): OutboxMessage {
    // A JSON round trip: the payload is exactly what the queue will carry.
    const payload = JSON.parse(JSON.stringify(event.toJSON())) as Record<string, unknown>;
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      event.data.walletId,
      payload,
      event.occurredAt,
      0,
    );
  }

  /** Rebuilds persisted state. */
  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.walletId,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  /** @returns Whether it is pending and its next attempt is not in the future. */
  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt <= now);
  }

  /** The queue accepted it. A message already published keeps its first time. */
  markPublished(at: Date): void {
    if (this.isPending()) this._publishedAt = at;
  }

  /**
   * Counts a failed attempt and schedules the next one; there is no limit of
   * attempts — giving up would lose a committed event.
   *
   * @param now - When the attempt failed.
   * @param backoff - Base, cap and randomness of the delay.
   */
  scheduleRetry(now: Date, backoff: RetryBackoff = DEFAULT_RETRY_BACKOFF): void {
    const random = backoff.random ?? Math.random;
    // 2^attempts overflows to Infinity long before it matters; the cap holds.
    const delay = Math.min(backoff.baseMs * 2 ** this._attempts, backoff.maxMs);
    const jittered = delay * (1 - JITTER + 2 * JITTER * random());
    this._attempts += 1;
    this._nextAttemptAt = new Date(now.getTime() + Math.round(jittered));
  }
}
