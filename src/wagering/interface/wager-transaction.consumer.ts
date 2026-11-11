/**
 * The consumer of `wager-transactions.fifo` of one instance: long polling,
 * each batch processed in parallel through the same use case as the HTTP
 * endpoint, with the message's inbox entry recorded in the SQL transaction of
 * the outcome. What the use case answers decides the message's fate
 * (`ARCHITECTURE.md` § Consumidor):
 *
 * - a transaction outcome — `PROCESSED`, `REJECTED`, `PENDING_REFERENCE` — or a
 *   redelivery the inbox already holds: `ack`, after the commit — a redelivery
 *   of a `FAILED` goes to the DLQ again first;
 * - a transient failure, or a wallet not there yet: no `ack`, the delivery
 *   comes back after `min(2^receiveCount s, ceiling)`; on the last receive, the
 *   use case gives up — `FAILED` `INFRA_RETRIES_EXHAUSTED` — or, for the
 *   wallet, the message is not admitted;
 * - `FAILED`: sent to the DLQ with its code, then `ack`;
 * - a submission not admitted: sent to the DLQ with its code and recorded in
 *   `rejected_submissions`, then `ack`.
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
import { createHash } from 'node:crypto';
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
import type {
  ProcessWagerTransaction,
  SubmitWagerTransactionCommand,
  WagerTransactionOutcome,
} from '../application/process-wager-transaction.ts';
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
   */
  async handle(message: ReceivedMessage): Promise<void> {
    const facts = factsOf(message);
    await this.deps.log.inContext({ messageId: facts.messageId, correlationId: facts.correlationId }, async () => {
      try {
        let parsed: WagerTransactionMessage;
        try {
          parsed = parseWagerTransactionMessage(message.body, { correlationId: message.attributes.correlationId });
        } catch (error) {
          if (!(error instanceof InvalidPayloadError)) throw error;
          return await this.notAdmitted(message, facts, FailureCode.InvalidPayload);
        }
        await this.settle(message, facts, parsed);
      } catch (error) {
        this.logger.warn(`queue message left unacknowledged: ${reasonOf(error)}`);
      }
    });
  }

  private async settle(message: ReceivedMessage, facts: MessageFacts, parsed: WagerTransactionMessage): Promise<void> {
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
      try {
        outcome = await this.giveUp(command, inbox, error);
      } catch (giveUpError) {
        // Still transient: left for the redrive. Anything else — a redelivery, a conflict — settles as refused.
        if (isRetryable(giveUpError)) throw giveUpError;
        return this.refused(message, facts, giveUpError);
      }
    }
    await this.settled(message, facts, outcome);
  }

  /** The use case gave an outcome: `FAILED` goes to the DLQ, the others are acknowledged. */
  private async settled(message: ReceivedMessage, facts: MessageFacts, outcome: WagerTransactionOutcome): Promise<void> {
    const { transaction } = outcome;
    if (transaction.status === WagerTransactionStatus.Failed) {
      await this.deadLetter(message, facts, transaction.failureCode ?? FailureCode.InfraUnexpected);
    } else {
      await this.deps.faults.inject(FaultPoint.CrashAfterCommit, { transactionId: transaction.id });
    }
    await this.deps.queue.acknowledge(message);
  }

  /** Records the submission `FAILED` `INFRA_RETRIES_EXHAUSTED`; if that fails too, the message waits for the redrive. */
  private async giveUp(
    command: SubmitWagerTransactionCommand,
    inbox: { consumerName: string; messageId: string; payloadHash: string },
    lastError: unknown,
  ): Promise<WagerTransactionOutcome> {
    this.deps.log.warn('queue message out of receives, giving up', { failureCode: retryCodeOf(lastError) });
    return this.deps.processWagerTransaction.giveUp(command, inbox);
  }

  /** The use case refused the message without an outcome. */
  private async refused(message: ReceivedMessage, facts: MessageFacts, error: unknown): Promise<void> {
    // Its first send to the DLQ may be what failed; the deduplication id absorbs a second one.
    if (error instanceof FailedRedeliveryError) {
      this.deps.metrics.inboxDuplicate();
      await this.deadLetter(message, facts, error.failureCode);
      return this.deps.queue.acknowledge(message);
    }
    if (error instanceof InboxRedeliveryError) {
      this.deps.metrics.inboxDuplicate();
      this.deps.log.info('queue message already in the inbox, acknowledged with no effect');
      return this.deps.queue.acknowledge(message);
    }
    const notAdmitted = NOT_ADMITTED.find(([type]) => error instanceof type);
    if (notAdmitted) return this.notAdmitted(message, facts, notAdmitted[1], payloadHashOf(error));
    // Even the `FAILED` could not be recorded: the DLQ is all that is left.
    if (error instanceof PermanentFailureError) {
      await this.deadLetter(message, facts, error.failureCode);
      return this.deps.queue.acknowledge(message);
    }
    throw error;
  }

  private async retry(message: ReceivedMessage, failureCode: string): Promise<void> {
    const delaySeconds = Math.min(2 ** message.receiveCount, this.options.retryMaxSeconds);
    this.deps.metrics.consumerRetry(failureCode);
    this.deps.log.info('queue message handed back for a retry', {
      failureCode,
      receiveCount: message.receiveCount,
      delaySeconds,
    });
    await this.deps.queue.changeVisibility(message, delaySeconds);
  }

  /** A submission not admitted: DLQ, its `rejected_submissions` row, then the `ack`. */
  private async notAdmitted(
    message: ReceivedMessage,
    facts: MessageFacts,
    failureCode: FailureCode,
    payloadHash?: string,
  ): Promise<void> {
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
    await this.deps.queue.acknowledge(message);
  }

  private async deadLetter(message: ReceivedMessage, facts: MessageFacts, failureCode: string): Promise<void> {
    await this.deps.deadLetters.send({
      body: message.body,
      attributes: message.attributes,
      failureCode,
      groupId: facts.walletId ?? UNROUTABLE_GROUP,
      deduplicationId: facts.messageId ?? createHash('sha256').update(message.body).digest('hex'),
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
      await Promise.all(messages.map((message) => this.handle(message)));
    }
  }

  /** Makes the message visible again at once; if that fails, its visibility expires on its own. */
  private async handBack(message: ReceivedMessage): Promise<void> {
    try {
      await this.deps.queue.changeVisibility(message, 0);
    } catch (error) {
      this.logger.warn(`queue message not handed back: ${reasonOf(error)}`);
    }
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
