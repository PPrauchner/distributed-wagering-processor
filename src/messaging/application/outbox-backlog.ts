/**
 * `OutboxBacklogQuery` port: how far the publication is behind — the messages
 * not published yet, the age of the oldest and how many of them are stuck —
 * read on the database clock, for the `outbox_pending`, `outbox_lag_seconds`
 * and `outbox_stuck_messages` metrics.
 *
 * @packageDocumentation
 */

export interface OutboxBacklog {
  pending: number;
  /** `now() − min(occurred_at)` of the unpublished messages; 0 when there is none. */
  lagSeconds: number;
  /** Unpublished messages with `STUCK_ATTEMPTS` failed attempts or more. */
  stuck: number;
}

export interface OutboxBacklogQuery {
  read(): Promise<OutboxBacklog>;
}

export interface OutboxBacklogRepositories {
  outboxBacklog: OutboxBacklogQuery;
}
