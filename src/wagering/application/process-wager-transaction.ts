/**
 * Processes a wager transaction submitted by a provider, whatever the channel:
 * validates it, deduplicates it by idempotency key and external id, locks its
 * wallet and records the outcome — transaction, balance, ledger entry and the
 * outcome's integration events in the outbox — in one unit of work, so in one
 * SQL transaction; the outbox publisher publishes them after the commit, never
 * this use case. Checks run in the documented
 * order, and the first violation decides (`ARCHITECTURE.md` § Ordem das
 * validações). It settles `BET`, `WIN`, `LOSS`, `REFUND` and `ROLLBACK`; a
 * transaction citing a reference not there yet is recorded
 * `PENDING_REFERENCE`, scheduled for the worker's first attempt, with
 * `WagerTransactionPendingReference`; only the worker resolves it.
 *
 * Error path (`ARCHITECTURE.md` § Classificação de falhas): a transient failure
 * records nothing and reaches the caller; a permanent one — or one nobody
 * classified, a bug or a domain error that escaped, recorded `INFRA_UNEXPECTED`
 * like the worker of pending references does — rolls the SQL
 * transaction back, and a second unit of work records the transaction as
 * `FAILED` — with `WagerTransactionFailed` in the outbox and its inbox row,
 * when it came by the queue —, so the key keeps
 * answering the same outcome. A transient failure never becomes `FAILED`: a
 * queue consumer out of receives sends the message to the DLQ with no outcome.
 *
 * Every submission that ends in a transaction is counted and timed by channel
 * and kind, and logged with its ids, kind and status — never its money;
 * idempotency and lock conflicts are counted on their way out.
 *
 * @packageDocumentation
 */
import {
  InboxRedeliveryError,
  MessageIdConflictError,
  type InboxEntry,
  type InboxRepositories,
} from '../../messaging/application/inbox-repository.ts';
import { InboxMessage } from '../../messaging/domain/inbox-message.ts';
import type { OutboxRepositories } from '../../messaging/application/outbox-repository.ts';
import type { ContextLog } from '../../shared/application/context-log.ts';
import { FaultPoint, type FaultInjection } from '../../shared/application/fault-injector.ts';
import { PermanentFailureError, TransientFailureError } from '../../shared/application/infrastructure-failures.ts';
import type { UnitOfWork } from '../../shared/application/unit-of-work.ts';
import { isUuid } from '../../shared/application/uuid.ts';
import { FailureCode } from '../../shared/domain/failure-code.ts';
import { CurrencyMismatchError, InvalidMoneyError, Money, type MoneyProps } from '../../shared/domain/money.ts';
import type { WalletRepositories } from '../../wallet/application/wallet-repository.ts';
import { SubmissionChannel } from '../domain/rejected-submission.ts';
import {
  InvalidWagerTransactionError,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  type CreateWagerTransactionProps,
} from '../domain/wager-transaction.ts';
import { enqueueFailureEvent, enqueueOutcomeEvents, settleOnWallet, type ReferenceWaitPolicy } from './settle-wager-transaction.ts';
import { hashWagerPayload, type WagerPayload } from './wager-payload.ts';
import type { WagerTransactionRepository, WageringRepositories } from './wager-transaction-repository.ts';
import { UNKNOWN_KIND, type ProcessingFailure, type WageringMetrics } from './wagering-metrics.ts';
import {
  DuplicateExternalIdError,
  DuplicateIdempotencyKeyError,
  ExternalIdConflictError,
  FailedRedeliveryError,
  IdempotencyConflictError,
  InternalKindNotAllowedError,
  SubmissionWalletNotFoundError,
} from './wagering-errors.ts';

/** A submission as the channel received it: shaped, not yet validated. */
export interface SubmitWagerTransactionCommand {
  idempotencyKey: string;
  /** Recorded on the transaction; generated when absent. */
  correlationId?: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

/** The transaction a submission ended in, and whether it was recorded before. */
export interface WagerTransactionOutcome {
  transaction: WagerTransaction;
  idempotentReplay: boolean;
}

const KINDS = new Set<string>(Object.values(WagerTransactionKind));

/** The refusals of a submission before it became a transaction. */
const NOT_ADMITTED_ERRORS = [
  InvalidMoneyError,
  CurrencyMismatchError,
  InvalidWagerTransactionError,
  InternalKindNotAllowedError,
  IdempotencyConflictError,
  ExternalIdConflictError,
  SubmissionWalletNotFoundError,
  MessageIdConflictError,
];

/**
 * How a submission that did not end in a transaction ended; `undefined` for a
 * redelivery the inbox already held — not a processing, counted as a duplicate.
 * A permanent error that escapes did not even record its `FAILED`; an error
 * nobody translated before the transaction existed — a bug in the validation —
 * is `permanent` too, never a refusal.
 */
function processingFailureOf(error: unknown): ProcessingFailure | undefined {
  if (error instanceof InboxRedeliveryError) return undefined;
  if (error instanceof TransientFailureError) return 'transient';
  if (NOT_ADMITTED_ERRORS.some((type) => error instanceof type)) return 'not_admitted';
  return 'permanent';
}

export class ProcessWagerTransaction {
  constructor(
    private readonly unitOfWork: UnitOfWork<
      WalletRepositories & WageringRepositories & OutboxRepositories & InboxRepositories & FaultInjection
    >,
    private readonly generateId: () => string,
    private readonly metrics: WageringMetrics,
    private readonly log: ContextLog,
    private readonly referenceWait: ReferenceWaitPolicy,
  ) {}

  /**
   * @param command - The submission, with its idempotency key already present.
   * @param channel - Where it came from, for the metrics.
   * @param inbox - The queue message it came in, when it came by the queue:
   *   recorded in the inbox, in the SQL transaction of the outcome — a
   *   replay's and a `FAILED`'s too.
   * @returns The transaction it ended in — `PROCESSED`, `REJECTED`,
   *   `PENDING_REFERENCE` or, after a permanent error, `FAILED` — new or replayed;
   *   a replay of a pending one answers its current status.
   * @throws {@link InvalidMoneyError} If the money is malformed.
   * @throws {@link InvalidWagerTransactionError} If any other field breaks the
   *   payload contract or the rules of its kind.
   * @throws {@link InternalKindNotAllowedError} If it is a well-formed `OPENING`.
   * @throws {@link IdempotencyConflictError} If the provider used the key with
   *   another payload.
   * @throws {@link ExternalIdConflictError} If the provider used the external id
   *   with another key.
   * @throws {@link SubmissionWalletNotFoundError} If the wallet does not exist.
   * @throws {@link TransientFailureError} If the wallet stayed locked too long
   *   or the database is unavailable: nothing was recorded.
   * @throws {@link PermanentFailureError} If even the `FAILED` could not be
   *   recorded for a permanent reason — an unclassified one as `INFRA_UNEXPECTED`.
   * @throws {@link FailedRedeliveryError} If the inbox already holds the
   *   message and its submission was recorded `FAILED`: nothing was recorded
   *   this time; it still belongs in the DLQ.
   * @throws {@link InboxRedeliveryError} If the inbox already holds the
   *   message: nothing was recorded this time.
   * @throws {@link MessageIdConflictError} If the inbox holds its `messageId`
   *   with another payload hash: nothing was recorded.
   */
  execute(
    command: SubmitWagerTransactionCommand,
    channel: SubmissionChannel,
    inbox?: InboxEntry,
  ): Promise<WagerTransactionOutcome> {
    return this.observed(channel, command.kind, () =>
      this.redeliveryChecked(command, inbox, () => this.process(command, inbox)),
    );
  }

  /**
   * Tells a redelivery the inbox refused from a `messageId` reused with
   * another payload, and a redelivery of a submission recorded `FAILED` — one
   * the consumer still owes the DLQ — from the others.
   */
  private async redeliveryChecked(
    command: SubmitWagerTransactionCommand,
    received: InboxEntry | undefined,
    work: () => Promise<WagerTransactionOutcome>,
  ): Promise<WagerTransactionOutcome> {
    try {
      return await work();
    } catch (error) {
      if (!received || !(error instanceof InboxRedeliveryError)) throw error;
      const { recorded, transaction } = await this.unitOfWork.run(async ({ inbox, transactions }) => ({
        recorded: await inbox.find(received.consumerName, received.messageId),
        transaction: await transactions.findByIdempotencyKey(command.providerId, command.idempotencyKey),
      }));
      if (recorded && recorded.payloadHash !== received.payloadHash) {
        throw new MessageIdConflictError(received.messageId, received.payloadHash);
      }
      if (transaction?.status === WagerTransactionStatus.Failed) {
        throw new FailedRedeliveryError(received.messageId, transaction.failureCode ?? FailureCode.InfraUnexpected, {
          cause: error,
        });
      }
      throw error;
    }
  }

  /**
   * Logs, counts and times the submission once it ended in a transaction;
   * times it too, by how it ended, when it did not.
   */
  private async observed(
    channel: SubmissionChannel,
    submittedKind: string,
    work: () => Promise<WagerTransactionOutcome>,
  ): Promise<WagerTransactionOutcome> {
    const started = performance.now();
    try {
      const outcome = await work();
      const { id, kind, status, failureCode } = outcome.transaction;
      const { idempotentReplay } = outcome;
      // A replay answers the transaction recorded first, not the one this submission would have created.
      this.log.enrich({ transactionId: id });
      this.log.info('wager transaction settled', { kind, status, failureCode, idempotentReplay });
      const durationSeconds = (performance.now() - started) / 1000;
      this.metrics.transactionSettled({ channel, kind, status, idempotentReplay, durationSeconds });
      return outcome;
    } catch (error) {
      if (error instanceof IdempotencyConflictError) this.metrics.idempotencyConflict(channel);
      if (error instanceof TransientFailureError && error.lockConflict) this.metrics.lockConflict(error.lockConflict);
      const outcome = processingFailureOf(error);
      if (outcome) {
        const kind = KINDS.has(submittedKind) ? (submittedKind as WagerTransactionKind) : UNKNOWN_KIND;
        const durationSeconds = (performance.now() - started) / 1000;
        this.metrics.processingFailed({ channel, kind, outcome, durationSeconds });
      }
      throw error;
    }
  }

  private async process(command: SubmitWagerTransactionCommand, inbox?: InboxEntry): Promise<WagerTransactionOutcome> {
    const { props, submitted } = this.validated(command);
    // The correlation id generated here, when the channel had none, is the one recorded.
    const { correlationId, id: transactionId, walletId, providerId } = props;
    this.log.enrich({ correlationId, transactionId, walletId, providerId });

    let failure: PermanentFailureError;
    try {
      return await this.settled(props, () => this.record(submitted, inbox));
    } catch (error) {
      const permanent = asPermanentFailure(error);
      if (!permanent) throw error;
      failure = permanent;
    }
    // The SQL transaction rolled back: record the failure in a unit of work of its own.
    try {
      return await this.settled(props, () => this.recordFailure(props, failure.failureCode, inbox));
    } catch (error) {
      throw asPermanentFailure(error) ?? error;
    }
  }

  /** Runs one attempt to record the submission, settling the races on its key. */
  private async settled(
    props: CreateWagerTransactionProps,
    attempt: () => Promise<WagerTransactionOutcome>,
  ): Promise<WagerTransactionOutcome> {
    try {
      return await attempt();
    } catch (error) {
      // A concurrent submission committed first, outside the lock. Which unique
      // index PostgreSQL reports is not the answer: read it back in the order
      // of the validations — key, then external id.
      if (error instanceof DuplicateIdempotencyKeyError || error instanceof DuplicateExternalIdError) {
        return this.readBack(props);
      }
      throw error;
    }
  }

  /**
   * Steps 4 to 8 of the order, in one unit of work. The inbox row, when the
   * submission came by the queue, is written with whatever the unit of work
   * commits — a new outcome or nothing but the row, on a replay —, so a
   * redelivery fails the commit on the inbox's primary key.
   */
  private record(submitted: WagerTransaction, received?: InboxEntry): Promise<WagerTransactionOutcome> {
    return this.unitOfWork.run(async ({ wallets, ledger, transactions, outbox, inbox, faults }) => {
      const recorded = (outcome: WagerTransactionOutcome): WagerTransactionOutcome => {
        if (received) inbox.add(processedInboxMessage(received));
        return outcome;
      };
      const earlier = await findEarlier(transactions, submitted);
      if (earlier) return recorded(earlier);

      const wallet = await wallets.findByIdForUpdate(submitted.walletId);
      if (!wallet) throw new SubmissionWalletNotFoundError(submitted.walletId, submitted.payloadHash);
      // A concurrent submission may have committed while this one waited for the lock.
      const committedMeanwhile = await findEarlier(transactions, submitted);
      if (committedMeanwhile) return recorded(committedMeanwhile);

      // Step 8 of the order: the rules of the kind, on the locked wallet.
      const entry = await settleOnWallet(submitted, wallet, transactions, this.generateId);
      if (submitted.status === WagerTransactionStatus.PendingReference) {
        submitted.scheduleReferenceAttempt(new Date(), this.referenceWait.backoff);
      }
      transactions.add(submitted);
      if (entry) ledger.add(entry);
      enqueueOutcomeEvents(
        outbox,
        { transaction: submitted, wallet, entry },
        { generateId: this.generateId, ttlMs: this.referenceWait.ttlMs },
      );
      const outcome = recorded({ transaction: submitted, idempotentReplay: false });
      await faults.inject(FaultPoint.InvariantViolationBeforeCommit, { transactionId: submitted.id });
      await faults.inject(FaultPoint.UnexpectedErrorBeforeCommit, { transactionId: submitted.id });
      return outcome;
    });
  }

  /**
   * The second unit of work: `FAILED`, with nothing observed and no ledger
   * entry, its `WagerTransactionFailed` — none on a replay —, and the inbox
   * row when it came by the queue — a replay's too. It
   * starts with the wallet lock, like every unit of work that touches the
   * wallet: inserting a row with a foreign key to it touches it (ADR 0002).
   */
  private recordFailure(
    props: CreateWagerTransactionProps,
    code: FailureCode,
    received?: InboxEntry,
  ): Promise<WagerTransactionOutcome> {
    return this.unitOfWork.run(async ({ wallets, transactions, outbox, inbox }) => {
      const wallet = await wallets.findByIdForUpdate(props.walletId);
      if (!wallet) throw new SubmissionWalletNotFoundError(props.walletId, props.payloadHash);
      if (received) inbox.add(processedInboxMessage(received));
      const failed = WagerTransaction.create(props);
      const earlier = await findEarlier(transactions, failed);
      if (earlier) return earlier;
      failed.fail(code);
      transactions.add(failed);
      enqueueFailureEvent(outbox, failed, this.generateId);
      return { transaction: failed, idempotentReplay: false };
    });
  }

  /**
   * The transaction a concurrent submission recorded under the key or the
   * external id: replay, idempotency conflict or external id conflict.
   */
  private async readBack(props: CreateWagerTransactionProps): Promise<WagerTransactionOutcome> {
    const earlier = await this.unitOfWork.run(({ transactions }) => findEarlier(transactions, props));
    if (!earlier) throw new Error('unique violation reported, but no transaction found');
    return earlier;
  }

  /**
   * Steps 2 and 3 of the order: the payload's shape, then its hash.
   *
   * @returns The transaction's creation props, with its id and correlation id
   *   fixed, so every attempt creates the same transaction, and the transaction
   *   created from them for the first attempt.
   */
  private validated(command: SubmitWagerTransactionCommand): {
    props: CreateWagerTransactionProps;
    submitted: WagerTransaction;
  } {
    assertWalletId(command.walletId);
    const money = Money.from(command.money);
    if (!KINDS.has(command.kind)) {
      throw new InvalidWagerTransactionError(`kind must be one of ${[...KINDS].join(', ')}, got "${command.kind}"`);
    }
    const payload: WagerPayload = {
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      playerId: command.playerId,
      // A UUID is case-insensitive: one spelling, so the hash and the events agree with the database.
      walletId: command.walletId.toLowerCase(),
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind as WagerTransactionKind,
      money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
    };
    const props: CreateWagerTransactionProps = {
      ...payload,
      id: this.generateId(),
      idempotencyKey: command.idempotencyKey,
      payloadHash: hashWagerPayload(payload),
      correlationId: command.correlationId ?? this.generateId(),
    };
    // `create` enforces the identifiers and the rules of the kind: amount floor and reference.
    const submitted = WagerTransaction.create(props);
    if (props.kind === WagerTransactionKind.Opening) throw new InternalKindNotAllowedError(props.kind, props.payloadHash);
    return { props, submitted };
  }
}

/**
 * The errors of recording a submission that are already an answer: a
 * transient failure, a redelivery, a refusal of the submission. Anything else
 * that escapes the recording is permanent.
 */
const CLASSIFIED_RECORDING_ERRORS = [
  TransientFailureError,
  InboxRedeliveryError,
  MessageIdConflictError,
  SubmissionWalletNotFoundError,
  IdempotencyConflictError,
  ExternalIdConflictError,
];

/**
 * @returns The permanent failure the error is: itself, or — for an error
 *   nobody classified, a bug or a domain error that escaped — `INFRA_UNEXPECTED`
 *   with it as the cause, since another attempt would fail the same way;
 *   `undefined` for an error that is already an answer.
 */
function asPermanentFailure(error: unknown): PermanentFailureError | undefined {
  if (error instanceof PermanentFailureError) return error;
  if (CLASSIFIED_RECORDING_ERRORS.some((type) => error instanceof type)) return undefined;
  return new PermanentFailureError(FailureCode.InfraUnexpected, { cause: error });
}

function processedInboxMessage(entry: InboxEntry): InboxMessage {
  const now = new Date();
  const message = InboxMessage.receive({ ...entry, receivedAt: now });
  message.markProcessed(now);
  return message;
}

/** What identifies a submission to its provider, and its fingerprint. */
type SubmissionKeys = Pick<
  CreateWagerTransactionProps,
  'providerId' | 'idempotencyKey' | 'externalTransactionId' | 'payloadHash'
>;

/**
 * Steps 4 and 5 of the order: the provider's key, then its external id.
 *
 * @returns The replay of the transaction already recorded under the key, or
 *   `undefined` when neither is known.
 */
async function findEarlier(
  transactions: WagerTransactionRepository,
  submitted: SubmissionKeys,
): Promise<WagerTransactionOutcome | undefined> {
  const earlier =
    (await transactions.findByIdempotencyKey(submitted.providerId, submitted.idempotencyKey)) ??
    (await transactions.findByExternalId(submitted.providerId, submitted.externalTransactionId));
  if (!earlier) return undefined;
  // The two reads are separate statements: a concurrent submission of the same
  // key may commit between them, and then shows up by its external id. Under
  // the same key it is this submission, not an external id conflict.
  if (earlier.idempotencyKey !== submitted.idempotencyKey) {
    throw new ExternalIdConflictError(submitted.providerId, submitted.externalTransactionId, submitted.payloadHash);
  }
  if (!earlier.matchesPayload(submitted.payloadHash)) {
    throw new IdempotencyConflictError(submitted.providerId, submitted.idempotencyKey, submitted.payloadHash);
  }
  return { transaction: earlier, idempotentReplay: true };
}

function assertWalletId(walletId: string): void {
  if (!isUuid(walletId)) {
    throw new InvalidWagerTransactionError(`walletId must be a UUID, got "${walletId}"`);
  }
}
