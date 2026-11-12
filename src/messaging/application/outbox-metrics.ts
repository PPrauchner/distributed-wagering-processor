/**
 * `OutboxMetrics` port: what the outbox publisher counts — each message it
 * reschedules after a failed send —, without depending on a metrics library
 * (`ARCHITECTURE.md` § Observabilidade).
 *
 * @packageDocumentation
 */

/** Injection token of the outbox metrics implementation. */
export const OUTBOX_METRICS = Symbol('OutboxMetrics');

export interface OutboxMetrics {
  /** A message rescheduled after a failed send. */
  publishRetry(): void;
}
