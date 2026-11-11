/**
 * HTTP contract of the wager transactions: the `POST` request parsing and its
 * outcome response, and the view a query answers with — the same outcome plus
 * the transaction's identity. Parsing checks the key first and then the body's shape
 * only; money, kind and identifier rules belong to the use case and the domain.
 *
 * @packageDocumentation
 */
import { HttpStatus } from '@nestjs/common';
import type { MoneyProps } from '../../shared/domain/money.ts';
import { expectExactObject, expectString } from '../../shared/interface/invalid-payload.error.ts';
import type {
  SubmitWagerTransactionCommand,
  WagerTransactionOutcome,
} from '../application/process-wager-transaction.ts';
import { MissingIdempotencyKeyError } from '../application/wagering-errors.ts';
import {
  WagerTransactionStatus,
  type WagerTransaction,
  type WagerTransactionKind,
} from '../domain/wager-transaction.ts';

/** The outcome of a transaction, as both the submission and the query answer it. */
interface WagerTransactionOutcomeBody {
  transactionId: string;
  status: WagerTransactionStatus;
  failureCode?: string;
  /** What the code alone does not say — the divergent field of a `REFERENCE_MISMATCH`. */
  message?: string;
  balance?: MoneyProps;
}

export interface WagerTransactionResponse extends WagerTransactionOutcomeBody {
  idempotentReplay: boolean;
}

/** A queried transaction: its outcome and its identity. */
export interface WagerTransactionView extends Omit<WagerTransactionOutcomeBody, 'balance'> {
  /** The balance the outcome observed; `null` when it observed none. */
  balance: MoneyProps | null;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

const FIELDS = [
  'providerId',
  'externalTransactionId',
  'playerId',
  'walletId',
  'roundId',
  'gameId',
  'kind',
  'money',
  'referenceExternalTransactionId',
] as const;
const OPTIONAL_FIELDS = ['referenceExternalTransactionId'];
const STRING_FIELDS = FIELDS.filter((field) => field !== 'money' && field !== 'referenceExternalTransactionId');

const STATUS_CODES: Partial<Record<WagerTransactionStatus, number>> = {
  [WagerTransactionStatus.Processed]: HttpStatus.OK,
  [WagerTransactionStatus.PendingReference]: HttpStatus.ACCEPTED,
  [WagerTransactionStatus.Rejected]: HttpStatus.UNPROCESSABLE_ENTITY,
  [WagerTransactionStatus.Failed]: HttpStatus.INTERNAL_SERVER_ERROR,
};

/**
 * @param body - The untrusted request body.
 * @param headers - The `Idempotency-Key` and `X-Correlation-Id` headers; an
 *   empty correlation id counts as absent, and the use case generates one.
 * @returns The submission command.
 * @throws {@link MissingIdempotencyKeyError} If the key is absent or empty —
 *   checked before the body.
 * @throws {@link InvalidPayloadError} If the body has a wrong shape, a wrong type
 *   or any unknown field, at any level.
 */
export function parseSubmitWagerTransactionRequest(
  body: unknown,
  headers: { idempotencyKey?: string; correlationId?: string },
): SubmitWagerTransactionCommand {
  if (!headers.idempotencyKey) throw new MissingIdempotencyKeyError();
  const request = expectExactObject(body, FIELDS, 'body', OPTIONAL_FIELDS);
  const money = expectExactObject(request.money, ['amount', 'currency'], 'body.money');
  const strings = Object.fromEntries(
    STRING_FIELDS.map((field) => [field, expectString(request[field], `body.${field}`)]),
  ) as Record<(typeof STRING_FIELDS)[number], string>;
  return {
    ...strings,
    idempotencyKey: headers.idempotencyKey,
    correlationId: headers.correlationId || undefined,
    money: {
      amount: expectString(money.amount, 'body.money.amount'),
      currency: expectString(money.currency, 'body.money.currency'),
    },
    referenceExternalTransactionId:
      'referenceExternalTransactionId' in request
        ? expectString(request.referenceExternalTransactionId, 'body.referenceExternalTransactionId')
        : undefined,
  };
}

/**
 * @param outcome - The transaction a submission ended in.
 * @returns The HTTP status of its outcome — 200 `PROCESSED`, 202
 *   `PENDING_REFERENCE`, 422 `REJECTED`, 500 `FAILED` — and the response body.
 * @throws {@link Error} If the transaction is in a status this slice never ends in.
 */
export function toWagerTransactionResponse(outcome: WagerTransactionOutcome): {
  statusCode: number;
  body: WagerTransactionResponse;
} {
  const { transaction, idempotentReplay } = outcome;
  const statusCode = STATUS_CODES[transaction.status];
  if (statusCode === undefined) throw new Error(`no HTTP outcome for status ${transaction.status}`);
  return { statusCode, body: { ...toOutcomeBody(transaction), idempotentReplay } };
}

/**
 * @param transaction - The queried transaction, in any status.
 * @returns Its outcome — the balance it observed, not the wallet's current
 *   one — and its identity.
 */
export function toWagerTransactionView(transaction: WagerTransaction): WagerTransactionView {
  return {
    ...toOutcomeBody(transaction),
    balance: transaction.balanceAfter?.toJSON() ?? null,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    playerId: transaction.playerId,
    walletId: transaction.walletId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    referenceExternalTransactionId: transaction.referenceExternalTransactionId,
  };
}

function toOutcomeBody(transaction: WagerTransaction): WagerTransactionOutcomeBody {
  return {
    transactionId: transaction.id,
    status: transaction.status,
    failureCode: transaction.failureCode,
    message: transaction.failureMessage,
    balance: transaction.balanceAfter?.toJSON(),
  };
}
