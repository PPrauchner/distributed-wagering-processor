/**
 * The consumer of `wager-transactions.fifo` of one instance: long polling,
 * each batch processed in parallel through the same use case as the HTTP
 * endpoint, with the message's inbox entry recorded in the SQL transaction of
 * the outcome. The `ack` comes only after the commit: an outcome —
 * `PROCESSED`, `REJECTED` or `PENDING_REFERENCE` — is acknowledged, and so is
 * a redelivery the inbox already holds, with no effect.
 *
 * Anything else is left unacknowledged and comes back when its visibility
 * expires: payloads not admitted, transient and permanent failures and `FAILED`
 * outcomes belong to the retry and DLQ slice (`ARCHITECTURE.md` § Consumidor).
 * On shutdown it stops receiving and waits for the batch in flight.
 *
 * @packageDocumentation
 */
import { Logger, type BeforeApplicationShutdown, type OnApplicationBootstrap } from '@nestjs/common';
import type { InboxMetrics } from '../../messaging/application/inbox-metrics.ts';
import { InboxRedeliveryError } from '../../messaging/application/inbox-repository.ts';
import type { InputQueue, ReceivedMessage } from '../../messaging/application/input-queue.ts';
import type { ContextLog } from '../../shared/application/context-log.ts';
import { FaultPoint, type FaultInjector } from '../../shared/application/fault-injector.ts';
import type { ProcessWagerTransaction } from '../application/process-wager-transaction.ts';
import { SubmissionChannel } from '../domain/rejected-submission.ts';
import { WagerTransactionStatus } from '../domain/wager-transaction.ts';
import { parseWagerTransactionMessage, type WagerTransactionMessage } from './wager-transaction.message.ts';

/** The consumer's name in the inbox. */
export const WAGER_TRANSACTIONS_CONSUMER = 'wager-transactions-consumer';

/** How long the loop waits after a failed receive before trying again. */
const RECEIVE_RETRY_MS = 1000;

export interface WagerTransactionConsumerOptions {
  enabled: boolean;
}

/** What the consumer does with a message once it settled. */
type Disposition = 'acknowledge' | 'leave';

export class WagerTransactionConsumer implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('WagerTransactionConsumer');
  private running = false;
  private loop: Promise<void> | undefined;

  constructor(
    private readonly queue: InputQueue,
    private readonly processWagerTransaction: ProcessWagerTransaction,
    private readonly metrics: InboxMetrics,
    private readonly log: ContextLog,
    private readonly faults: FaultInjector,
    private readonly options: WagerTransactionConsumerOptions,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.options.enabled) return;
    this.running = true;
    this.loop = this.run();
  }

  // Before the shutdown hooks, where the ORM and the SQS client close.
  async beforeApplicationShutdown(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  /**
   * Settles one message and acknowledges it when it should be; never throws —
   * a message it cannot settle is left for its visibility to expire.
   *
   * @param message - The message as the queue delivered it.
   */
  async handle(message: ReceivedMessage): Promise<void> {
    let parsed: WagerTransactionMessage;
    try {
      parsed = parseWagerTransactionMessage(message.body, { correlationId: message.attributes.correlationId });
    } catch (error) {
      this.logger.warn(`queue message not admitted, left unacknowledged: ${reasonOf(error)}`);
      return;
    }
    const { messageId, command } = parsed;
    await this.log.inContext({ messageId, correlationId: command.correlationId }, async () => {
      try {
        if ((await this.settle(parsed)) === 'acknowledge') await this.queue.acknowledge(message);
      } catch (error) {
        this.logger.warn(`queue message left unacknowledged: ${reasonOf(error)}`);
      }
    });
  }

  private async settle({ messageId, payloadHash, command }: WagerTransactionMessage): Promise<Disposition> {
    try {
      const { transaction } = await this.processWagerTransaction.execute(command, SubmissionChannel.Queue, {
        consumerName: WAGER_TRANSACTIONS_CONSUMER,
        messageId,
        payloadHash,
      });
      if (transaction.status === WagerTransactionStatus.Failed) {
        this.logger.warn(`queue message ended FAILED (${transaction.failureCode}), left unacknowledged`);
        return 'leave';
      }
      await this.faults.inject(FaultPoint.CrashAfterCommit, { transactionId: transaction.id });
      return 'acknowledge';
    } catch (error) {
      if (!(error instanceof InboxRedeliveryError)) throw error;
      this.metrics.inboxDuplicate();
      this.log.info('queue message already in the inbox, acknowledged with no effect');
      return 'acknowledge';
    }
  }

  private async run(): Promise<void> {
    while (this.running) {
      let messages: ReceivedMessage[];
      try {
        messages = await this.queue.receive();
      } catch (error) {
        this.logger.warn(`receive from the input queue failed: ${reasonOf(error)}`);
        await Bun.sleep(RECEIVE_RETRY_MS);
        continue;
      }
      await Promise.all(messages.map((message) => this.handle(message)));
    }
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
