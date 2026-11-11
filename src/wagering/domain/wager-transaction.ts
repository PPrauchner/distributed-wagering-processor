/**
 * `WagerTransaction`: a financial operation a provider sends about a round, or
 * the internal `OPENING`. Born `PENDING` in memory — never persisted so — and
 * moved to a terminal status by its transitions (`ARCHITECTURE.md` §
 * Transições da transação de aposta).
 *
 * @packageDocumentation
 */
import type { FailureCode } from '../../shared/domain/failure-code.ts';
import type { Money } from '../../shared/domain/money.ts';
import { LedgerDirection } from '../../wallet/domain/wallet-ledger-entry.ts';
import { referenceRetryDelayMs, type ReferenceRetryBackoff } from './reference-wait.ts';

export enum WagerTransactionKind {
  /** Internal: credits a wallet's initial balance; never comes from a provider. */
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  /** The provider's id of the referenced transaction, not the internal one. */
  referenceExternalTransactionId?: string;
  correlationId: string;
}

/** Persisted state of a transaction, rebuilt as is by {@link WagerTransaction.rehydrate}. */
export interface WagerTransactionState extends CreateWagerTransactionProps {
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  failureMessage?: string;
  processedAt?: Date;
  balanceAfter?: Money;
  walletVersionObserved?: number;
  attempts?: number;
  nextAttemptAt?: Date;
}

/** What processing a transaction leaves on it. */
export interface ProcessedOutcome {
  at: Date;
  /** The wallet balance right after the transaction, read under lock. */
  balanceAfter: Money;
  walletVersionObserved: number;
  referenceTransactionId?: string;
}

/** What a rejection leaves on a transaction. */
export interface RejectedOutcome {
  code: FailureCode;
  /** What the code alone does not say — the divergent field of a `REFERENCE_MISMATCH`. */
  message?: string;
  /** The wallet balance, untouched, read under lock — in the wallet's currency. */
  balanceAfter: Money;
  walletVersionObserved: number;
}

/** Raised when a transaction would be created breaking a rule of its kind. */
export class InvalidWagerTransactionError extends Error {
  override readonly name = 'InvalidWagerTransactionError';
}

/** A transition from a terminal status: a programming error, not a business path. */
export class InvalidTransactionStateError extends Error {
  override readonly name = 'InvalidTransactionStateError';
}

const MAX_IDENTIFIER_LENGTH = 255;
const TERMINAL_STATUSES = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

export class WagerTransaction {
  // Only assigns parameters: the ORM's metadata discovery calls the constructor
  // with no arguments (ADR 0001), so validation lives in `create`.
  private constructor(
    readonly id: string,
    readonly providerId: string,
    readonly externalTransactionId: string,
    readonly idempotencyKey: string,
    readonly payloadHash: string,
    readonly walletId: string,
    readonly playerId: string,
    readonly roundId: string,
    readonly gameId: string,
    readonly kind: WagerTransactionKind,
    readonly money: Money,
    readonly referenceExternalTransactionId: string | undefined,
    readonly correlationId: string,
    readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _balanceAfter?: Money,
    private _walletVersionObserved?: number,
    private _failureMessage?: string,
    private _attempts?: number,
    private _nextAttemptAt?: Date,
  ) {}

  /**
   * Creates a transaction in `PENDING`.
   *
   * @param props - The transaction as submitted.
   * @returns The new transaction.
   * @throws {@link InvalidWagerTransactionError} If an identifier — of the
   *   provider, the transaction, the key, the player, the round, the game or the
   *   reference — is empty or longer than 255 characters, the amount is not
   *   positive (zero is allowed only for `LOSS`), or the reference is missing on a
   *   `REFUND`/`ROLLBACK`, present on an `OPENING`/`BET`/`LOSS`, or equal to
   *   the transaction's own external id.
   */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    const transaction = new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.correlationId,
      new Date(),
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
    );
    transaction.assertCreatable();
    return transaction;
  }

  /** Rebuilds persisted state; does not re-run the creation rules nor the transitions. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.correlationId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.balanceAfter,
      state.walletVersionObserved,
      state.failureMessage,
      state.attempts,
      state.nextAttemptAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get failureMessage(): string | undefined {
    return this._failureMessage;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get balanceAfter(): Money | undefined {
    return this._balanceAfter;
  }

  get walletVersionObserved(): number | undefined {
    return this._walletVersionObserved;
  }

  /** The attempts the worker already made to resolve a pending reference. */
  get attempts(): number {
    return this._attempts ?? 0;
  }

  /** When the worker tries a pending reference next; unset outside `PENDING_REFERENCE`. */
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  /**
   * The transaction was applied.
   *
   * @param outcome - When, and the balance and wallet version it left.
   * @throws {@link InvalidTransactionStateError} If the transaction is terminal.
   */
  markProcessed(outcome: ProcessedOutcome): void {
    this.assertNotTerminal();
    this._status = WagerTransactionStatus.Processed;
    this._processedAt = outcome.at;
    this._balanceAfter = outcome.balanceAfter;
    this._walletVersionObserved = outcome.walletVersionObserved;
    this._referenceTransactionId = outcome.referenceTransactionId;
  }

  /**
   * A business rule refused the transaction; the wallet is untouched.
   *
   * @param outcome - The failure code, and the balance and wallet version observed.
   * @throws {@link InvalidTransactionStateError} If the transaction is terminal.
   */
  reject(outcome: RejectedOutcome): void {
    this.assertNotTerminal();
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = outcome.code;
    this._failureMessage = outcome.message;
    this._balanceAfter = outcome.balanceAfter;
    this._walletVersionObserved = outcome.walletVersionObserved;
  }

  /**
   * A permanent error: auditable, with nothing observed.
   *
   * @param code - The failure code.
   * @throws {@link InvalidTransactionStateError} If the transaction is terminal.
   */
  fail(code: FailureCode): void {
    this.assertNotTerminal();
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
  }

  /**
   * The referenced transaction does not exist yet. Only leaves `PENDING`: a
   * pending reference that keeps waiting is rescheduled, not transitioned.
   *
   * @throws {@link InvalidTransactionStateError} If the transaction is not `PENDING`.
   */
  markPendingReference(): void {
    if (this._status !== WagerTransactionStatus.Pending) {
      throw new InvalidTransactionStateError(`transaction ${this.id} is ${this._status}, not PENDING`);
    }
    this._status = WagerTransactionStatus.PendingReference;
  }

  /**
   * Schedules the first attempt of a pending reference, after the base delay.
   *
   * @param now - When it started waiting.
   * @param backoff - Base, cap and randomness of the delay.
   * @throws {@link InvalidTransactionStateError} If the transaction is not `PENDING_REFERENCE`.
   */
  scheduleReferenceAttempt(now: Date, backoff: ReferenceRetryBackoff): void {
    this.assertPendingReference();
    this._nextAttemptAt = new Date(now.getTime() + referenceRetryDelayMs(this.attempts, backoff));
  }

  /**
   * An attempt found no reference: counts it and schedules the next one.
   * There is no limit of attempts — the TTL already limits the wait.
   *
   * @param now - When the attempt was made.
   * @param backoff - Base, cap and randomness of the delay.
   * @throws {@link InvalidTransactionStateError} If the transaction is not `PENDING_REFERENCE`.
   */
  retryReference(now: Date, backoff: ReferenceRetryBackoff): void {
    this.assertPendingReference();
    this._attempts = this.attempts + 1;
    this.scheduleReferenceAttempt(now, backoff);
  }

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  /** Whether the kind undoes another transaction, so it must cite it: `REFUND` and `ROLLBACK`. */
  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  /** Whether the kind moves the balance; a `LOSS` only records it. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  /**
   * How the transaction moves its wallet's balance: a `BET` debits; an
   * `OPENING`, a `WIN` and a `REFUND` credit; a `ROLLBACK` applies the inverse
   * of its reference — undoing a debit credits it back, undoing a credit debits it.
   *
   * @param reference - The transaction it cites, resolved; only a `ROLLBACK`
   *   needs it.
   * @returns The direction of its ledger entry.
   * @throws {@link InvalidTransactionStateError} If it does not move the
   *   balance — check {@link WagerTransaction.affectsBalance} first —, or is a
   *   `ROLLBACK` given no reference that moves it.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (reference === undefined) {
          throw new InvalidTransactionStateError(`ROLLBACK ${this.id} has no reference to invert`);
        }
        const undone = reference.ledgerDirectionFor();
        return undone === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvalidTransactionStateError(`${this.kind} ${this.id} does not move the balance`);
      default:
        return assertNever(this.kind);
    }
  }

  /**
   * Whether a submission under this transaction's key carries its payload: a
   * replay when it does, an idempotency conflict when it does not.
   *
   * @param payloadHash - The hash of the payload submitted.
   */
  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** The rules on the transaction as submitted: its identifiers, then the reference and amount floor of its kind. */
  private assertCreatable(): void {
    this.assertIdentifierLengths();
    const hasReference = this.referenceExternalTransactionId !== undefined;
    if (this.requiresReference() && !hasReference) {
      throw new InvalidWagerTransactionError(`${this.kind} requires a reference`);
    }
    // Besides the kinds that undo one, only a `WIN` may cite a reference: its round's bet.
    if (hasReference && !this.requiresReference() && this.kind !== WagerTransactionKind.Win) {
      throw new InvalidWagerTransactionError(`${this.kind} does not take a reference`);
    }
    if (this.referenceExternalTransactionId === this.externalTransactionId) {
      throw new InvalidWagerTransactionError(`${this.kind} cannot reference itself`);
    }
    const amountFloorOk = this.affectsBalance() ? this.money.isPositive() : !this.money.isNegative();
    if (!amountFloorOk) {
      throw new InvalidWagerTransactionError(`amount ${this.money} is not allowed for ${this.kind}`);
    }
  }

  private assertIdentifierLengths(): void {
    const identifiers: [string, string | undefined][] = [
      ['providerId', this.providerId],
      ['externalTransactionId', this.externalTransactionId],
      ['idempotencyKey', this.idempotencyKey],
      ['playerId', this.playerId],
      ['roundId', this.roundId],
      ['gameId', this.gameId],
      ['referenceExternalTransactionId', this.referenceExternalTransactionId],
    ];
    for (const [name, value] of identifiers) {
      if (value !== undefined && (value.length === 0 || value.length > MAX_IDENTIFIER_LENGTH)) {
        throw new InvalidWagerTransactionError(`${name} must have between 1 and ${MAX_IDENTIFIER_LENGTH} characters`);
      }
    }
  }

  private assertPendingReference(): void {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(`transaction ${this.id} is ${this._status}, not PENDING_REFERENCE`);
    }
  }

  private assertNotTerminal(): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(`transaction ${this.id} is already ${this._status}`);
    }
  }
}

function assertNever(kind: never): never {
  throw new Error(`unknown wager transaction kind: ${String(kind)}`);
}
