/**
 * The consumer of `wager-transactions.fifo` of one instance: long polling,
 * each batch split by the `MessageGroupId` received — one message at a time
 * within a group, in delivery order, the groups in parallel — through the same
 * use case as the HTTP endpoint, with the message's inbox entry recorded in the SQL transaction of
 * the outcome. What the use case answers decides the message's fate
 * (`ARCHITECTURE.md` § Consumidor):
 *
 * - a transaction outcome — `PROCESSED`, `REJECTED`, `PENDING_REFERENCE` — or a
 *   redelivery the inbox already holds: `ack`, after the commit — a redelivery
 *   of a `FAILED` goes to the DLQ again first;
 * - a transient failure, or a wallet not there yet: no `ack`, the delivery
 *   comes back after `min(2^receiveCount s, ceiling)`; on the last receive, it
 *   ends with no outcome, as a submission not admitted — `INFRA_RETRIES_EXHAUSTED`,
 *   or `WALLET_NOT_FOUND` for the wallet —, and its key stays free;
 * - `FAILED`: sent to the DLQ with its code, then `ack`;
 * - a submission not admitted: sent to the DLQ with its code and recorded in
 *   `rejected_submissions`, then `ack`.
 *
 * A message of a group that ends with no `ack` keeps the ones after it in the
 * batch from starting: they go back to the queue unstarted, to reappear with
 * it — the delay of its retry, or the visibility timeout when it was left
 * as is — and be redelivered in order, after it. Not at once: LocalStack 4.14
 * releases a group as soon as any of its messages is visible again, even with
 * an earlier one still in flight.
 *
 * Every send to the DLQ comes before the `ack`: if either fails, the message
 * stays, and its redelivery is settled again — by the inbox, when an outcome
 * was recorded.
 *
 * On shutdown it cuts the long poll short, hands back at once — visibility 0
 * — whatever arrives unstarted, and waits for the messages in progress up to
 * the drain timeout; past it, the SQL transaction's atomicity and the inbox
 * make the redelivery safe.
 *
 * @packageDocumentation
 */
import { Logger, type BeforeApplicationShutdown, type OnApplicationBootstrap } from '@nestjs/common';
import type { ConsumerMetrics } from '../../messaging/application/consumer-metrics.ts';
import type { DeadLetterQueue } from '../../messaging/application/dead-letter-queue.ts';
import { InboxRedeliveryError, MessageIdConflictError } from '../../messaging/application/inbox-repository.ts';
import type { InputQueue, ReceivedMessage } from '../../messaging/application/input-queue.ts';
import type { ContextLog } from '../../shared/application/context-log.ts';
import { FaultPoint, type FaultInjector } from '../../shared/application/fault-injector.ts';
import { PermanentFailureError, TransientFailureError } from '../../shared/application/infrastructure-failures.ts';
import { FailureCode } from '../../shared/domain/failure-code.ts';
import { CurrencyMismatchError, InvalidMoneyError } from '../../shared/domain/money.ts';
import { InvalidPayloadError } from '../../shared/interface/invalid-payload.error.ts';
import type { ProcessWagerTransaction, WagerTransactionOutcome } from '../application/process-wager-transaction.ts';
import type { RecordRejectedSubmission } from '../application/record-rejected-submission.ts';
import {
  ExternalIdConflictError,
  FailedRedeliveryError,
  IdempotencyConflictError,
  InternalKindNotAllowedError,
  SubmissionWalletNotFoundError,
  UnsupportedKindError,
} from '../application/wagering-errors.ts';
import { SubmissionChannel } from '../domain/rejected-submission.ts';
import { InvalidWagerTransactionError, WagerTransactionStatus } from '../domain/wager-transaction.ts';
import { parseWagerTransactionMessage, type WagerTransactionMessage } from './wager-transaction.message.ts';

/** The consumer's name in the inbox. */
export const WAGER_TRANSACTIONS_CONSUMER = 'wager-transactions-consumer';

/** How long the loop waits after a failed receive before trying again. */
const RECEIVE_RETRY_MS = 1000;

/** The DLQ group of a message that names no wallet. */
const UNROUTABLE_GROUP = 'unroutable';

/** What SQS takes as a group id: 1 to 128 ASCII letters, digits and punctuation. */
const SQS_ID = /^[!-~]{1,128}$/;

export interface WagerTransactionConsumerDependencies {
  queue: InputQueue;
  deadLetters: DeadLetterQueue;
  processWagerTransaction: ProcessWagerTransaction;
  recordRejectedSubmission: RecordRejectedSubmission;
  metrics: ConsumerMetrics;
  log: ContextLog;
  faults: FaultInjector;
}

export interface WagerTransactionConsumerOptions {
  enabled: boolean;
  /** The receive at which a transient failure is given up on. */
  maxReceives: number;
  /** The ceiling of the retry backoff, in seconds. */
  retryMaxSeconds: number;
  /** How long a shutdown waits for the messages in progress. */
  drainTimeoutMs: number;
}

const INVALID_PAYLOAD_ERRORS = [
  InvalidPayloadError,
  InvalidMoneyError,
  CurrencyMismatchError,
  InvalidWagerTransactionError,
  UnsupportedKindError,
];

// Submissions not admitted the use case refuses, by failure code; the payload's shape comes first.
const NOT_ADMITTED: [new (...args: never[]) => Error, FailureCode][] = [
  ...INVALID_PAYLOAD_ERRORS.map((type): [new (...args: never[]) => Error, FailureCode] => [type, FailureCode.InvalidPayload]),
  [InternalKindNotAllowedError, FailureCode.InternalKindNotAllowed],
  [IdempotencyConflictError, FailureCode.IdempotencyConflict],
  [ExternalIdConflictError, FailureCode.ExternalIdConflict],
  [MessageIdConflictError, FailureCode.MessageIdConflict],
];

/**
 * What became of a message: acknowledged, or still in the queue — visible
 * again after `reappearsInSeconds`, or after its visibility timeout when absent.
 */
export type Settlement = { acknowledged: true } | { acknowledged: false; reappearsInSeconds?: number };

const ACKNOWLEDGED: Settlement = { acknowledged: true };

/** What could be extracted from a message, valid or not, for the DLQ and the audit. */
interface MessageFacts {
  messageId?: string;
  correlationId?: string;
  walletId?: string;
  providerId?: string;
  externalTransactionId?: string;
  idempotencyKey?: string;
}

export class WagerTransactionConsumer implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('WagerTransactionConsumer');
  private running = false;
  private loop: Promise<void> | undefined;
  private readonly stopping = new AbortController();

  constructor(
    private readonly deps: WagerTransactionConsumerDependencies,
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
    this.stopping.abort();
    if (!this.loop) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const drained = await Promise.race([
      this.loop.then(() => true),
      new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), this.options.drainTimeoutMs))),
    ]);
    clearTimeout(timer);
    if (!drained) this.logger.warn(`messages still in progress after ${this.options.drainTimeoutMs} ms; shutting down`);
  }

  /**
   * Settles one message: acknowledges it, hands it back for a retry or sends
   * it to the DLQ; never throws — a message it cannot settle is left for its
   * visibility to expire.
   *
   * @param message - The message as the queue delivered it.
   * @returns Whether it was acknowledged and, if not, when it reappears.
   */
  async handle(message: ReceivedMessage): Promise<Settlement> {
    const facts = factsOf(message);
    return this.deps.log.inContext({ messageId: facts.messageId, correlationId: facts.correlationId }, async () => {
      try {
        let parsed: WagerTransactionMessage;
        try {
          parsed = parseWagerTransactionMessage(message.body, { correlationId: message.attributes.correlationId });
        } catch (error) {
          if (!(error instanceof InvalidPayloadError)) throw error;
          return await this.notAdmitted(message, facts, FailureCode.InvalidPayload);
        }
        return await this.settle(message, facts, parsed);
      } catch (error) {
        this.logger.warn(`queue message left unacknowledged: ${reasonOf(error)}`);
        return { acknowledged: false };
      }
    });
  }

  private async settle(message: ReceivedMessage, facts: MessageFacts, parsed: WagerTransactionMessage): Promise<Settlement> {
    const { messageId, payloadHash, command } = parsed;
    const inbox = { consumerName: WAGER_TRANSACTIONS_CONSUMER, messageId, payloadHash };
    let outcome: WagerTransactionOutcome;
    try {
      outcome = await this.deps.processWagerTransaction.execute(command, SubmissionChannel.Queue, inbox);
    } catch (error) {
      if (!isRetryable(error)) return this.refused(message, facts, error);
      if (message.receiveCount < this.options.maxReceives) return this.retry(message, retryCodeOf(error));
      if (error instanceof SubmissionWalletNotFoundError) {
        return this.notAdmitted(message, facts, FailureCode.WalletNotFound, error.payloadHash);
      }
      // Out of receives: no outcome, the key stays free for the DLQ redrive or a resend.
      this.deps.log.warn('queue message out of receives', { failureCode: retryCodeOf(error) });
      return this.notAdmitted(message, facts, FailureCode.InfraRetriesExhausted, payloadHash);
    }
    return this.settled(message, facts, outcome);
  }

  /** The use case gave an outcome: `FAILED` goes to the DLQ, the others are acknowledged. */
  private async settled(message: ReceivedMessage, facts: MessageFacts, outcome: WagerTransactionOutcome): Promise<Settlement> {
    const { transaction } = outcome;
    if (transaction.status === WagerTransactionStatus.Failed) {
      await this.deadLetter(message, facts, transaction.failureCode ?? FailureCode.InfraUnexpected);
    } else {
      await this.deps.faults.inject(FaultPoint.CrashAfterCommit, { transactionId: transaction.id });
    }
    return this.acknowledge(message);
  }

  /** The use case refused the message without an outcome. */
  private async refused(message: ReceivedMessage, facts: MessageFacts, error: unknown): Promise<Settlement> {
    // Its first send to the DLQ may be what failed; the deduplication id absorbs a second one of the same delivery.
    if (error instanceof FailedRedeliveryError) {
      this.deps.metrics.inboxDuplicate();
      await this.deadLetter(message, facts, error.failureCode);
      return this.acknowledge(message);
    }
    if (error instanceof InboxRedeliveryError) {
      this.deps.metrics.inboxDuplicate();
      this.deps.log.info('queue message already in the inbox, acknowledged with no effect');
      return this.acknowledge(message);
    }
    const notAdmitted = NOT_ADMITTED.find(([type]) => error instanceof type);
    if (notAdmitted) return this.notAdmitted(message, facts, notAdmitted[1], payloadHashOf(error));
    // Even the `FAILED` could not be recorded: the DLQ is all that is left.
    if (error instanceof PermanentFailureError) {
      await this.deadLetter(message, facts, error.failureCode);
      return this.acknowledge(message);
    }
    throw error;
  }

  private async retry(message: ReceivedMessage, failureCode: string): Promise<Settlement> {
    const delaySeconds = Math.min(2 ** message.receiveCount, this.options.retryMaxSeconds);
    this.deps.metrics.consumerRetry(failureCode);
    this.deps.log.info('queue message handed back for a retry', {
      failureCode,
      receiveCount: message.receiveCount,
      delaySeconds,
    });
    await this.deps.queue.changeVisibility(message, delaySeconds);
    return { acknowledged: false, reappearsInSeconds: delaySeconds };
  }

  /** A submission not admitted: DLQ, its `rejected_submissions` row, then the `ack`. */
  private async notAdmitted(
    message: ReceivedMessage,
    facts: MessageFacts,
    failureCode: FailureCode,
    payloadHash?: string,
  ): Promise<Settlement> {
    await this.deadLetter(message, facts, failureCode);
    await this.deps.recordRejectedSubmission.execute({
      failureCode,
      channel: SubmissionChannel.Queue,
      messageId: facts.messageId,
      correlationId: facts.correlationId,
      providerId: facts.providerId,
      externalTransactionId: facts.externalTransactionId,
      idempotencyKey: facts.idempotencyKey,
      payloadHash,
    });
    return this.acknowledge(message);
  }

  private async acknowledge(message: ReceivedMessage): Promise<Settlement> {
    await this.deps.queue.acknowledge(message);
    return ACKNOWLEDGED;
  }

  private async deadLetter(message: ReceivedMessage, facts: MessageFacts, failureCode: string): Promise<void> {
    await this.deps.deadLetters.send({
      body: message.body,
      attributes: message.attributes,
      failureCode,
      groupId: sqsIdOrUndefined(facts.walletId) ?? UNROUTABLE_GROUP,
      // The delivery, not the envelope: a message out of receives again after a redrive must reach the DLQ again.
      deduplicationId: message.deliveryId,
    });
    this.deps.metrics.deadLettered(failureCode);
    this.deps.log.warn('queue message sent to the DLQ', { failureCode });
  }

  private async run(): Promise<void> {
    while (this.running) {
      let messages: ReceivedMessage[];
      try {
        messages = await this.deps.queue.receive(this.stopping.signal);
      } catch (error) {
        this.logger.warn(`receive from the input queue failed: ${reasonOf(error)}`);
        await Bun.sleep(RECEIVE_RETRY_MS);
        continue;
      }
      // Received while shutting down: none started, all handed back for another instance.
      if (!this.running) {
        await Promise.all(messages.map((message) => this.handBack(message)));
        return;
      }
      await Promise.all(byGroup(messages).map((group) => this.handleGroup(group)));
    }
  }

  /**
   * One group's messages, in delivery order, one at a time. The ones after a
   * message left in the queue go back unstarted, to reappear with it:
   * processing them first would undo the group's order. Once the shutdown
   * began, the rest is handed back at once.
   */
  private async handleGroup(group: ReceivedMessage[]): Promise<void> {
    for (const [index, message] of group.entries()) {
      if (!this.running) {
        await Promise.all(group.slice(index).map((rest) => this.handBack(rest)));
        return;
      }
      const settlement = await this.handle(message);
      if (!settlement.acknowledged) {
        const delay = settlement.reappearsInSeconds;
        // With no delay set, the rest keeps the visibility timeout of the batch, like the message.
        if (delay !== undefined) await Promise.all(group.slice(index + 1).map((rest) => this.handBack(rest, delay)));
        return;
      }
    }
  }

  /** Makes the message visible again after `seconds`; if that fails, its visibility expires on its own. */
  private async handBack(message: ReceivedMessage, seconds = 0): Promise<void> {
    try {
      await this.deps.queue.changeVisibility(message, seconds);
    } catch (error) {
      this.logger.warn(`queue message not handed back: ${reasonOf(error)}`);
    }
  }
}

/**
 * The batch split by the `MessageGroupId` received — never by the body's
 * `walletId` —, each group in delivery order; a message with no group is a
 * group of its own.
 */
function byGroup(messages: ReceivedMessage[]): ReceivedMessage[][] {
  const groups = new Map<string, ReceivedMessage[]>();
  const loose: ReceivedMessage[][] = [];
  for (const message of messages) {
    if (message.groupId === undefined) loose.push([message]);
    else groups.set(message.groupId, [...(groups.get(message.groupId) ?? []), message]);
  }
  return [...groups.values(), ...loose];
}

/** A transient failure, or a wallet that may still be created: worth another delivery. */
function isRetryable(error: unknown): error is TransientFailureError | SubmissionWalletNotFoundError {
  return error instanceof TransientFailureError || error instanceof SubmissionWalletNotFoundError;
}

function retryCodeOf(error: unknown): string {
  return error instanceof TransientFailureError ? error.failureCode : FailureCode.WalletNotFound;
}

function payloadHashOf(error: unknown): string | undefined {
  const payloadHash = (error as { payloadHash?: unknown }).payloadHash;
  return typeof payloadHash === 'string' ? payloadHash : undefined;
}

/** Whatever identifiers the body carries as text, even when it is not a valid envelope. */
function factsOf(message: ReceivedMessage): MessageFacts {
  let envelope: unknown;
  try {
    envelope = JSON.parse(message.body);
  } catch {
    envelope = undefined;
  }
  const data = isRecord(envelope) && isRecord(envelope.data) ? envelope.data : {};
  const messageId = isRecord(envelope) ? text(envelope.messageId) : undefined;
  return {
    messageId,
    correlationId: text(message.attributes.correlationId) ?? messageId,
    walletId: text(data.walletId)?.toLowerCase(),
    providerId: text(data.providerId),
    externalTransactionId: text(data.externalTransactionId),
    idempotencyKey: text(data.idempotencyKey),
  };
}

/** The value, if SQS takes it as a group id: one from an untrusted body may not be. */
function sqsIdOrUndefined(value: string | undefined): string | undefined {
  return value !== undefined && SQS_ID.test(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
