/**
 * `InboxMetrics` port: what a consumer counts about its inbox, without
 * depending on a metrics library (`ARCHITECTURE.md` § Observabilidade).
 *
 * @packageDocumentation
 */

/** Injection token of the inbox metrics implementation. */
export const INBOX_METRICS = Symbol('InboxMetrics');

export interface InboxMetrics {
  /** A message the inbox already held, acknowledged with no effect. */
  inboxDuplicate(): void;
}
