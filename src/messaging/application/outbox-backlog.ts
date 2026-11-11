/**
 * `OutboxBacklogQuery` port: how far the publication is behind — the messages
 * not published yet and the age of the oldest — read on the database clock, for
 * the `outbox_pending` and `outbox_lag_seconds` metrics.
 *
 * @packageDocumentation
 */

export interface OutboxBacklog {
  pending: number;
  /** `now() − min(occurred_at)` of the unpublished messages; 0 when there is none. */
  lagSeconds: number;
}

export interface OutboxBacklogQuery {
  read(): Promise<OutboxBacklog>;
}

export interface OutboxBacklogRepositories {
  outboxBacklog: OutboxBacklogQuery;
}
