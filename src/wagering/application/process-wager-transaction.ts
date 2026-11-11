/**
 * Processes a wager transaction submitted by a provider, whatever the channel:
 * validates it, deduplicates it by idempotency key and external id, locks its
 * wallet and records the outcome — transaction, balance, ledger entry and the
 * outcome's integration events in the outbox — in one unit of work, so in one
 * SQL transaction; the outbox publisher publishes them after the commit, never
 * this use case. Checks run in the documented
 * order, and the first violation decides (`ARCHITECTURE.md` § Ordem das
 * validações). This slice settles `BET`, `WIN` and `LOSS`; a `WIN` citing a
 * reference not there yet is recorded `PENDING_REFERENCE`, with no event.
 *
 * Error path (`ARCHITECTURE.md` § Classificação de falhas): a transient failure
 * records nothing and reaches the caller; a permanent one rolls the SQL
 * transaction back, and a second unit of work records the transaction as
 * `FAILED`, so the key keeps answering the same outcome.
 *
 * Every submission that ends in a transaction is counted and timed by channel
 * and kind, and logged with its ids, kind and status — never its money;
 * idempotency and lock conflicts are counted on their way out.
 *
 * @packageDocumentation
 */
import type { OutboxRepositories, OutboxRepository } from '../../messaging/application/outbox-repository.ts';
import { OutboxMessage } from '../../messaging/domain/outbox-message.ts';
import type { ContextLog } from '../../shared/application/context-log.ts';
import { FaultPoint, type FaultInjection } from '../../shared/application/fault-injector.ts';
import {
  PermanentFailureError,
  TransientFailureError,
  type PermanentFailureCode,
} from '../../shared/application/infrastructure-failures.ts';
import type { UnitOfWork } from '../../shared/application/unit-of-work.ts';
import { Money, type MoneyProps } from '../../shared/domain/money.ts';
import type { WalletRepositories } from '../../wallet/application/wallet-repository.ts';
import type { Wallet } from '../../wallet/domain/wallet.ts';
import { WalletBalanceChanged } from '../../wallet/domain/wallet-balance-changed.ts';
import type { WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry.ts';
import { applyBet } from '../domain/bet.ts';
import { applyLoss } from '../domain/loss.ts';
import type { SubmissionChannel } from '../domain/rejected-submission.ts';
import { applyWin } from '../domain/win.ts';
import { WagerTransactionProcessed, WagerTransactionRejected } from '../domain/wager-transaction-events.ts';
import {
  InvalidWagerTransactionError,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  type CreateWagerTransactionProps,
} from '../domain/wager-transaction.ts';
import { hashWagerPayload, type WagerPayload } from './wager-payload.ts';
import type { WagerTransactionRepository, WageringRepositories } from './wager-transaction-repository.ts';
import type { WageringMetrics } from './wagering-metrics.ts';
import {
  DuplicateExternalIdError,
  DuplicateIdempotencyKeyError,
  ExternalIdConflictError,
  IdempotencyConflictError,
  InternalKindNotAllowedError,
  SubmissionWalletNotFoundError,
  UnsupportedKindError,
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

const MAX_IDENTIFIER_LENGTH = 255;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = new Set<string>(Object.values(WagerTransactionKind));
const SUPPORTED_KINDS = new Set([WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Loss]);

export class ProcessWagerTransaction {
  constructor(
    private readonly unitOfWork: UnitOfWork<
      WalletRepositories & WageringRepositories & OutboxRepositories & FaultInjection
    >,
    private readonly generateId: () => string,
    private readonly metrics: WageringMetrics,
    private readonly log: ContextLog,
  ) {}

  /**
   * @param command - The submission, with its idempotency key already present.
   * @param channel - Where it came from, for the metrics.
   * @returns The transaction it ended in — `PROCESSED`, `REJECTED`,
   *   `PENDING_REFERENCE` or, after a permanent error, `FAILED` — new or replayed;
   *   a replay of a pending one answers its current status.
   * @throws {@link InvalidMoneyError} If the money is malformed.
   * @throws {@link InvalidWagerTransactionError} If any other field breaks the
   *   payload contract or the rules of its kind.
   * @throws {@link InternalKindNotAllowedError} If it is a well-formed `OPENING`.
   * @throws {@link UnsupportedKindError} If its kind is not processed yet.
   * @throws {@link IdempotencyConflictError} If the provider used the key with
   *   another payload.
   * @throws {@link ExternalIdConflictError} If the provider used the external id
   *   with another key.
   * @throws {@link SubmissionWalletNotFoundError} If the wallet does not exist.
   * @throws {@link TransientFailureError} If the wallet stayed locked too long
   *   or the database is unavailable: nothing was recorded.
   * @throws {@link PermanentFailureError} If even the `FAILED` could not be
   *   recorded for a permanent reason.
   */
  async execute(command: SubmitWagerTransactionCommand, channel: SubmissionChannel): Promise<WagerTransactionOutcome> {
    const started = performance.now();
    try {
      const outcome = await this.process(command);
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
      throw error;
    }
  }

  private async process(command: SubmitWagerTransactionCommand): Promise<WagerTransactionOutcome> {
    const { props, submitted } = this.validated(command);
    // The correlation id generated here, when the channel had none, is the one recorded.
    const { correlationId, id: transactionId, walletId, providerId } = props;
    this.log.enrich({ correlationId, transactionId, walletId, providerId });

    try {
      return await this.settled(props, () => this.record(submitted));
    } catch (error) {
      if (!(error instanceof PermanentFailureError)) throw error;
      // The SQL transaction rolled back: record the failure in a unit of work of its own.
      return this.settled(props, () => this.recordFailure(props, error.failureCode));
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
      if (error instanceof DuplicateExternalIdError) {
        throw new ExternalIdConflictError(props.providerId, props.externalTransactionId, props.payloadHash);
      }
      // A concurrent submission of the same key committed first, outside the lock.
      if (error instanceof DuplicateIdempotencyKeyError) return this.readBack(props);
      throw error;
    }
  }

  /** Steps 4 to 8 of the order, in one unit of work. */
  private record(submitted: WagerTransaction): Promise<WagerTransactionOutcome> {
    return this.unitOfWork.run(async ({ wallets, ledger, transactions, outbox, faults }) => {
      const earlier = await findEarlier(transactions, submitted);
      if (earlier) return earlier;

      const wallet = await wallets.findByIdForUpdate(submitted.walletId);
      if (!wallet) throw new SubmissionWalletNotFoundError(submitted.walletId, submitted.payloadHash);
      // A concurrent submission may have committed while this one waited for the lock.
      const committedMeanwhile = await findEarlier(transactions, submitted);
      if (committedMeanwhile) return committedMeanwhile;

      const entry = await this.settle(submitted, wallet, transactions);
      transactions.add(submitted);
      if (entry) ledger.add(entry);
      this.enqueueEvents(outbox, submitted, wallet, entry);
      await faults.inject(FaultPoint.InvariantViolationBeforeCommit, { transactionId: submitted.id });
      return { transaction: submitted, idempotentReplay: false };
    });
  }

  /**
   * Step 8 of the order: the rules of the transaction's kind, on its locked
   * wallet. A `WIN` citing a reference reads it by its provider and external id.
   *
   * @returns The ledger entry to persist, when the balance moved.
   */
  private async settle(
    transaction: WagerTransaction,
    wallet: Wallet,
    transactions: WagerTransactionRepository,
  ): Promise<WalletLedgerEntry | undefined> {
    const ids = { entryId: this.generateId() };
    switch (transaction.kind) {
      case WagerTransactionKind.Bet:
        return applyBet(transaction, wallet, ids);
      case WagerTransactionKind.Win: {
        const { referenceExternalTransactionId } = transaction;
        const reference =
          referenceExternalTransactionId === undefined
            ? undefined
            : ((await transactions.findByExternalId(transaction.providerId, referenceExternalTransactionId)) ??
              undefined);
        return applyWin(transaction, wallet, reference, ids);
      }
      case WagerTransactionKind.Loss:
        applyLoss(transaction, wallet);
        return undefined;
      default:
        throw new UnsupportedKindError(transaction.kind);
    }
  }

  /**
   * The outcome's integration events: processed, with its balance change when
   * the balance moved; rejected; none while waiting for a reference. Added
   * before anything that may still fail in the unit of work, so they are
   * committed or rolled back with the outcome.
   */
  private enqueueEvents(
    outbox: OutboxRepository,
    transaction: WagerTransaction,
    wallet: Wallet,
    entry: WalletLedgerEntry | undefined,
  ): void {
    const context = { correlationId: transaction.correlationId, causationId: transaction.id };
    if (transaction.status === WagerTransactionStatus.Rejected) {
      const rejected = WagerTransactionRejected.from(transaction, context, { eventId: this.generateId(), at: new Date() });
      outbox.add(OutboxMessage.enqueue(rejected));
      return;
    }
    if (transaction.status !== WagerTransactionStatus.Processed) return;
    const processed = WagerTransactionProcessed.from(transaction, context, { eventId: this.generateId() });
    outbox.add(OutboxMessage.enqueue(processed));
    if (entry === undefined) return;
    const changed = WalletBalanceChanged.from(wallet, entry, context, { eventId: this.generateId() });
    outbox.add(OutboxMessage.enqueue(changed));
  }

  /** The second unit of work: `FAILED`, with nothing observed and no ledger entry. */
  private recordFailure(
    props: CreateWagerTransactionProps,
    code: PermanentFailureCode,
  ): Promise<WagerTransactionOutcome> {
    return this.unitOfWork.run(async ({ transactions }) => {
      const failed = WagerTransaction.create(props);
      const earlier = await findEarlier(transactions, failed);
      if (earlier) return earlier;
      failed.fail(code);
      transactions.add(failed);
      return { transaction: failed, idempotentReplay: false };
    });
  }

  /** The transaction a concurrent submission recorded under the key: replay or conflict. */
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
    assertIdentifiers(command);
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
    // `create` enforces the rules of the kind: amount floor and reference.
    const submitted = WagerTransaction.create(props);
    if (props.kind === WagerTransactionKind.Opening) throw new InternalKindNotAllowedError(props.kind, props.payloadHash);
    if (!SUPPORTED_KINDS.has(props.kind)) throw new UnsupportedKindError(props.kind);
    return { props, submitted };
  }
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
  if (earlier.payloadHash !== submitted.payloadHash) {
    throw new IdempotencyConflictError(submitted.providerId, submitted.idempotencyKey, submitted.payloadHash);
  }
  return { transaction: earlier, idempotentReplay: true };
}

function assertIdentifiers(command: SubmitWagerTransactionCommand): void {
  const identifiers: [string, string | undefined][] = [
    ['Idempotency-Key', command.idempotencyKey],
    ['providerId', command.providerId],
    ['externalTransactionId', command.externalTransactionId],
    ['playerId', command.playerId],
    ['roundId', command.roundId],
    ['gameId', command.gameId],
    ['referenceExternalTransactionId', command.referenceExternalTransactionId],
  ];
  for (const [name, value] of identifiers) {
    if (value !== undefined && (value.length === 0 || value.length > MAX_IDENTIFIER_LENGTH)) {
      throw new InvalidWagerTransactionError(`${name} must have between 1 and ${MAX_IDENTIFIER_LENGTH} characters`);
    }
  }
  if (!UUID_PATTERN.test(command.walletId)) {
    throw new InvalidWagerTransactionError(`walletId must be a UUID, got "${command.walletId}"`);
  }
}
