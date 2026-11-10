/**
 * `WagerTransaction`: a financial operation a provider sends about a round, or
 * the internal `OPENING`. Born `PENDING` in memory — never persisted so — and
 * moved to a terminal status by its transitions (`ARCHITECTURE.md` §
 * Transições da transação de aposta).
 *
 * @packageDocumentation
 */
import type { Money } from '../../shared/domain/money.ts';

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

/** Stable, machine-readable reason of a rejection or failure. */
export type FailureCode = string;

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

/** What processing a transaction leaves on it. */
export interface ProcessedOutcome {
  at: Date;
  /** The wallet balance right after the transaction, read under lock. */
  balanceAfter: Money;
  walletVersionObserved: number;
  referenceTransactionId?: string;
}

/** Raised when a transaction would be created breaking a rule of its kind. */
export class InvalidWagerTransactionError extends Error {
  override readonly name = 'InvalidWagerTransactionError';
}

/** A transition from a terminal status: a programming error, not a business path. */
export class InvalidTransactionStateError extends Error {
  override readonly name = 'InvalidTransactionStateError';
}

const KINDS_REQUIRING_REFERENCE = new Set([WagerTransactionKind.Refund, WagerTransactionKind.Rollback]);
const KINDS_WITHOUT_REFERENCE = new Set([
  WagerTransactionKind.Opening,
  WagerTransactionKind.Bet,
  WagerTransactionKind.Loss,
]);
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
  ) {}

  /**
   * Creates a transaction in `PENDING`.
   *
   * @param props - The transaction as submitted.
   * @returns The new transaction.
   * @throws {@link InvalidWagerTransactionError} If the amount is not positive
   *   (zero is allowed only for `LOSS`), or the reference is missing on a
   *   `REFUND`/`ROLLBACK` or present on an `OPENING`/`BET`/`LOSS`.
   */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    const hasReference = props.referenceExternalTransactionId !== undefined;
    if (KINDS_REQUIRING_REFERENCE.has(props.kind) && !hasReference) {
      throw new InvalidWagerTransactionError(`${props.kind} requires a reference`);
    }
    if (KINDS_WITHOUT_REFERENCE.has(props.kind) && hasReference) {
      throw new InvalidWagerTransactionError(`${props.kind} does not take a reference`);
    }
    const amountFloorOk =
      props.kind === WagerTransactionKind.Loss ? !props.money.isNegative() : props.money.isPositive();
    if (!amountFloorOk) {
      throw new InvalidWagerTransactionError(`amount ${props.money} is not allowed for ${props.kind}`);
    }
    return new WagerTransaction(
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

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get balanceAfter(): Money | undefined {
    return this._balanceAfter;
  }

  get walletVersionObserved(): number | undefined {
    return this._walletVersionObserved;
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

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  private assertNotTerminal(): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(`transaction ${this.id} is already ${this._status}`);
    }
  }
}
