/**
 * `ConsumerMetrics` port: what a queue consumer counts on its failure path —
 * the deliveries it hands back for a retry and the messages it sends to the
 * DLQ —, without depending on a metrics library (`ARCHITECTURE.md` §
 * Observabilidade).
 *
 * @packageDocumentation
 */
import type { InboxMetrics } from './inbox-metrics.ts';

/** Injection token of the consumer metrics implementation. */
export const CONSUMER_METRICS = Symbol('ConsumerMetrics');

export interface ConsumerMetrics extends InboxMetrics {
  /** A delivery left for a later one, by the failure code that stopped it. */
  consumerRetry(failureCode: string): void;
  /** A message the application sent to the DLQ, by its `failureCode`. */
  deadLettered(failureCode: string): void;
}
