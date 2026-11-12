/**
 * Publishes the outbox (`ARCHITECTURE.md` § Publicador da outbox): claims a
 * batch of due messages by lease in a short unit of work of its own, sends it,
 * then records the outcome of each message in another short unit of work —
 * `published_at` for the sent ones, `scheduleRetry` for the others. None of
 * them touches a wallet, so the lock order of ADR 0002 holds.
 *
 * A failed send is never silent: it is logged with its reason, so a
 * misconfigured queue shows up while the committed events wait in the outbox.
 * Each reschedule is counted, and the failed attempt that makes a message
 * stuck — the 10th — raises an alert with its id, never its payload.
 *
 * At-least-once: a publisher that dies after the send and before recording it
 * leaves the messages leased; when the lease expires, another publisher sends
 * them again, with the same `eventId`.
 *
 * @packageDocumentation
 */
import { FaultPoint, type FaultInjection } from '../../shared/application/fault-injector.ts';
import type { UnitOfWork } from '../../shared/application/unit-of-work.ts';
import type { ContextLog } from '../../shared/application/context-log.ts';
import { describeError } from '../../shared/application/error-summary.ts';
import { STUCK_ATTEMPTS, type OutboxMessage, type RetryBackoff } from '../domain/outbox-message.ts';
import type { EventPublisher, PublishResult } from './event-publisher.ts';
import type { OutboxMetrics } from './outbox-metrics.ts';
import type { OutboxRepositories } from './outbox-repository.ts';

/** The SQS batch limit. */
export const OUTBOX_BATCH_SIZE = 10;

export interface PublishOutboxOptions {
  leaseMs: number;
  backoff: RetryBackoff;
}

/** Where the publisher reports the sends that failed and the stuck messages. */
export type PublicationLog = Pick<ContextLog, 'warn'>;

export class PublishOutbox {
  constructor(
    private readonly unitOfWork: UnitOfWork<OutboxRepositories & FaultInjection>,
    private readonly publisher: EventPublisher,
    private readonly options: PublishOutboxOptions,
    private readonly log: PublicationLog,
    private readonly metrics: OutboxMetrics,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * One cycle: claim, send, record.
   *
   * @returns How many messages were claimed; 0 when none was due.
   * @throws {@link SimulatedCrashError} At `crash-after-send`, when enabled.
   */
  async publishDue(): Promise<number> {
    const claimed = await this.unitOfWork.run(({ outbox }) =>
      outbox.claimDue(OUTBOX_BATCH_SIZE, this.options.leaseMs),
    );
    if (claimed.length === 0) return 0;

    const result = await this.send(claimed);
    const at = this.now();
    const rescheduled: OutboxMessage[] = [];
    await this.unitOfWork.run(async ({ outbox, faults }) => {
      await faults.inject(FaultPoint.CrashAfterSend, {});
      const published = new Set(result.published);
      for (const message of claimed) {
        if (published.has(message.id)) {
          message.markPublished(at);
          await outbox.markPublished(message);
        } else {
          message.scheduleRetry(at, this.options.backoff);
          await outbox.reschedule(message);
          rescheduled.push(message);
        }
      }
    });
    // Counted and alerted only once committed: a rolled-back attempt comes back when its lease expires.
    for (const message of rescheduled) {
      this.metrics.publishRetry();
      if (message.attempts === STUCK_ATTEMPTS) {
        this.log.warn(`outbox message failed ${STUCK_ATTEMPTS} attempts, still retrying`, {
          messageId: message.id,
          eventType: message.eventType,
          attempts: message.attempts,
        });
      }
    }
    return claimed.length;
  }

  /** A batch that could not be sent at all fails every message in it. */
  private async send(messages: readonly OutboxMessage[]): Promise<PublishResult> {
    let result: PublishResult;
    try {
      result = await this.publisher.publish(messages);
    } catch (error) {
      const reason = describeError(error);
      this.log.warn(`outbox batch of ${messages.length} could not be sent, rescheduled: ${reason}`);
      return { published: [], failed: messages.map((message) => ({ id: message.id, reason })) };
    }
    if (result.failed.length > 0) {
      const reasons = result.failed.map((failure) => `${failure.id} (${failure.reason})`).join(', ');
      this.log.warn(`outbox messages refused by the queue, rescheduled: ${reasons}`);
    }
    return result;
  }
}
