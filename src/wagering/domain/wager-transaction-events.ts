/**
 * The integration events of a wager transaction's outcome, with the `data` of
 * the contracts table (`ARCHITECTURE.md` § Eventos de integração): the
 * transaction's identity, plus what its outcome left. Money goes as
 * `MoneyProps`, timestamps as ISO-8601 strings, so the payload is stable JSON.
 *
 * @packageDocumentation
 */
import { IntegrationEvent, type EventContext } from '../../shared/domain/integration-event.ts';
import type { FailureCode } from '../../shared/domain/failure-code.ts';
import type { MoneyProps } from '../../shared/domain/money.ts';
import { WagerTransactionStatus, type WagerTransaction, type WagerTransactionKind } from './wager-transaction.ts';

/** What every transaction event carries. */
export interface WagerTransactionEventData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

export interface WagerTransactionProcessedData extends WagerTransactionEventData {
  referenceTransactionId?: string;
  balanceAfter: MoneyProps;
  walletVersion: number;
  processedAt: string;
}

export interface WagerTransactionRejectedData extends WagerTransactionEventData {
  failureCode: FailureCode;
  balanceAfter: MoneyProps;
  walletVersion: number;
  rejectedAt: string;
}

/** Raised when an event is built from a transaction without that outcome. */
export class EventOutcomeMismatchError extends Error {
  override readonly name = 'EventOutcomeMismatchError';
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  /**
   * @param transaction - A `PROCESSED` transaction.
   * @param context - Correlation and causation of the outcome.
   * @param ids - The new event's id.
   * @returns The event, aggregated by the transaction id, occurred when it was processed.
   * @throws {@link EventOutcomeMismatchError} If the transaction is not `PROCESSED`.
   */
  static from(transaction: WagerTransaction, context: EventContext, ids: { eventId: string }): WagerTransactionProcessed {
    const { processedAt, balanceAfter, walletVersionObserved } = transaction;
    if (
      transaction.status !== WagerTransactionStatus.Processed ||
      processedAt === undefined ||
      balanceAfter === undefined ||
      walletVersionObserved === undefined
    ) {
      throw new EventOutcomeMismatchError(`transaction ${transaction.id} is ${transaction.status}, not PROCESSED`);
    }
    return new WagerTransactionProcessed({
      eventId: ids.eventId,
      aggregateId: transaction.id,
      ...context,
      occurredAt: processedAt,
      data: {
        ...identityOf(transaction),
        referenceTransactionId: transaction.referenceTransactionId,
        balanceAfter: balanceAfter.toJSON(),
        walletVersion: walletVersionObserved,
        processedAt: processedAt.toISOString(),
      },
    });
  }
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  /**
   * @param transaction - A `REJECTED` transaction.
   * @param context - Correlation and causation of the outcome.
   * @param ids - The new event's id, and when the transaction was rejected.
   * @returns The event, aggregated by the transaction id.
   * @throws {@link EventOutcomeMismatchError} If the transaction is not `REJECTED`.
   */
  static from(
    transaction: WagerTransaction,
    context: EventContext,
    ids: { eventId: string; at: Date },
  ): WagerTransactionRejected {
    const { failureCode, balanceAfter, walletVersionObserved } = transaction;
    if (
      transaction.status !== WagerTransactionStatus.Rejected ||
      failureCode === undefined ||
      balanceAfter === undefined ||
      walletVersionObserved === undefined
    ) {
      throw new EventOutcomeMismatchError(`transaction ${transaction.id} is ${transaction.status}, not REJECTED`);
    }
    return new WagerTransactionRejected({
      eventId: ids.eventId,
      aggregateId: transaction.id,
      ...context,
      occurredAt: ids.at,
      data: {
        ...identityOf(transaction),
        failureCode,
        balanceAfter: balanceAfter.toJSON(),
        walletVersion: walletVersionObserved,
        rejectedAt: ids.at.toISOString(),
      },
    });
  }
}

function identityOf(transaction: WagerTransaction): WagerTransactionEventData {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    referenceExternalTransactionId: transaction.referenceExternalTransactionId,
  };
}
