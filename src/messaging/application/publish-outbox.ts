/**
 * Publishes the outbox (`ARCHITECTURE.md` § Publicador da outbox): claims a
 * batch of due messages by lease in a short unit of work of its own, sends it,
 * then records the outcome of each message in another short unit of work —
 * `published_at` for the sent ones, `scheduleRetry` for the others. None of
 * them touches a wallet, so the lock order of ADR 0002 holds.
 *
 * At-least-once: a publisher that dies after the send and before recording it
 * leaves the messages leased; when the lease expires, another publisher sends
 * them again, with the same `eventId`.
 *
 * @packageDocumentation
 */
import { FaultPoint, type FaultInjection } from '../../shared/application/fault-injector.ts';
import type { UnitOfWork } from '../../shared/application/unit-of-work.ts';
import type { OutboxMessage, RetryBackoff } from '../domain/outbox-message.ts';
import type { EventPublisher, PublishResult } from './event-publisher.ts';
import type { OutboxRepositories } from './outbox-repository.ts';

/** The SQS batch limit. */
export const OUTBOX_BATCH_SIZE = 10;

export interface PublishOutboxOptions {
  leaseMs: number;
  backoff: RetryBackoff;
}

export class PublishOutbox {
  constructor(
    private readonly unitOfWork: UnitOfWork<OutboxRepositories & FaultInjection>,
    private readonly publisher: EventPublisher,
    private readonly options: PublishOutboxOptions,
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
        }
      }
    });
    return claimed.length;
  }

  /** A batch that could not be sent at all fails every message in it. */
  private async send(messages: readonly OutboxMessage[]): Promise<PublishResult> {
    try {
      return await this.publisher.publish(messages);
    } catch {
      return { published: [], failed: messages.map((message) => message.id) };
    }
  }
}
