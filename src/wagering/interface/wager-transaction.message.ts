/**
 * Queue contract of a wager transaction: the §10 envelope (`messageId`,
 * `type`, `occurredAt`, `data`) read into the same command the HTTP endpoint
 * builds — the key comes from `data` —, and what the inbox needs of it.
 * Parsing checks the shape only — and that the envelope is a
 * `WagerTransactionRequested` with an ISO-8601 `occurredAt`; money, kind and
 * identifier rules belong to the use case and the domain, as by HTTP.
 *
 * @packageDocumentation
 */
import { hashPayload, type CanonicalValue } from '../../shared/application/payload-hash.ts';
import {
  InvalidPayloadError,
  expectExactObject,
  expectString,
} from '../../shared/interface/invalid-payload.error.ts';
import type { SubmitWagerTransactionCommand } from '../application/process-wager-transaction.ts';

/** A queue message read into a submission. */
export interface WagerTransactionMessage {
  /** The envelope's `messageId`, the inbox's key. */
  messageId: string;
  /** The payload hash of `data`, as received. */
  payloadHash: string;
  command: SubmitWagerTransactionCommand;
}

const MESSAGE_TYPE = 'WagerTransactionRequested';
/** `YYYY-MM-DDTHH:mm:ss[.fff]` and a time zone, `Z` or an offset. */
const ISO_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d+)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/;
const ENVELOPE_FIELDS = ['messageId', 'type', 'occurredAt', 'data'];
const DATA_FIELDS = [
  'providerId',
  'externalTransactionId',
  'idempotencyKey',
  'playerId',
  'walletId',
  'roundId',
  'gameId',
  'kind',
  'money',
  'referenceExternalTransactionId',
] as const;
const OPTIONAL_DATA_FIELDS = ['referenceExternalTransactionId'];
const STRING_DATA_FIELDS = DATA_FIELDS.filter(
  (field) => field !== 'money' && field !== 'referenceExternalTransactionId',
);

/**
 * @param body - The untrusted message body.
 * @param attributes - The message attributes; `correlationId`, when present,
 *   is the correlation id — the `messageId` otherwise.
 * @returns The submission, its `messageId` and the hash of its `data`.
 * @throws {@link InvalidPayloadError} If the body is not JSON, or the envelope
 *   or its `data` has a wrong shape, a wrong type or an unknown field.
 */
export function parseWagerTransactionMessage(
  body: string,
  attributes: { correlationId?: string },
): WagerTransactionMessage {
  const envelope = expectExactObject(parseJson(body), ENVELOPE_FIELDS, 'message');
  const messageId = expectString(envelope.messageId, 'message.messageId');
  if (messageId.length === 0) throw new InvalidPayloadError('message.messageId must not be empty');
  if (expectString(envelope.type, 'message.type') !== MESSAGE_TYPE) {
    throw new InvalidPayloadError(`message.type must be ${MESSAGE_TYPE}`);
  }
  if (!isIsoDateTime(expectString(envelope.occurredAt, 'message.occurredAt'))) {
    throw new InvalidPayloadError('message.occurredAt must be an ISO-8601 date-time with a time zone');
  }
  const data = expectExactObject(envelope.data, DATA_FIELDS, 'message.data', OPTIONAL_DATA_FIELDS);
  const money = expectExactObject(data.money, ['amount', 'currency'], 'message.data.money');
  const strings = Object.fromEntries(
    STRING_DATA_FIELDS.map((field) => [field, expectString(data[field], `message.data.${field}`)]),
  ) as Record<(typeof STRING_DATA_FIELDS)[number], string>;
  return {
    messageId,
    payloadHash: hashPayload(data as CanonicalValue),
    command: {
      ...strings,
      // Trimmed as by HTTP, so one provider key is one key on both channels; a
      // key of spaces only arrives empty, and the domain refuses it.
      idempotencyKey: strings.idempotencyKey.trim(),
      correlationId: attributes.correlationId || messageId,
      money: {
        amount: expectString(money.amount, 'message.data.money.amount'),
        currency: expectString(money.currency, 'message.data.money.currency'),
      },
      referenceExternalTransactionId:
        'referenceExternalTransactionId' in data
          ? expectString(data.referenceExternalTransactionId, 'message.data.referenceExternalTransactionId')
          : undefined,
    },
  };
}

/** An ISO-8601 date-time with a time zone, on a day the calendar has. */
function isIsoDateTime(value: string): boolean {
  const match = ISO_DATE_TIME.exec(value);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new InvalidPayloadError('message is not valid JSON');
  }
}
