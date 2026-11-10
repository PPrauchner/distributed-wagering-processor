/**
 * HTTP contract of `POST /wagering/transactions`: request parsing and the
 * outcome response. Parsing checks the key first and then the body's shape
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
import { WagerTransactionStatus } from '../domain/wager-transaction.ts';

export interface WagerTransactionResponse {
  transactionId: string;
  status: WagerTransactionStatus;
  failureCode?: string;
  balance?: MoneyProps;
  idempotentReplay: boolean;
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
  [WagerTransactionStatus.Rejected]: HttpStatus.UNPROCESSABLE_ENTITY,
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
 * @returns The HTTP status of its outcome — 200 `PROCESSED`, 422 `REJECTED` —
 *   and the response body.
 * @throws {@link Error} If the transaction is in a status this slice never ends in.
 */
export function toWagerTransactionResponse(outcome: WagerTransactionOutcome): {
  statusCode: number;
  body: WagerTransactionResponse;
} {
  const { transaction, idempotentReplay } = outcome;
  const statusCode = STATUS_CODES[transaction.status];
  if (statusCode === undefined) throw new Error(`no HTTP outcome for status ${transaction.status}`);
  return {
    statusCode,
    body: {
      transactionId: transaction.id,
      status: transaction.status,
      failureCode: transaction.failureCode,
      balance: transaction.balanceAfter?.toJSON(),
      idempotentReplay,
    },
  };
}
