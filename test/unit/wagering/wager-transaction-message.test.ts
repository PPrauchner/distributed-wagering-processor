/**
 * Unit tests for the queue contract of a wager transaction: the §10 envelope
 * read into the same command the HTTP endpoint builds.
 *
 * @packageDocumentation
 */
import { describe, expect, test } from 'bun:test';
import { hashPayload } from '../../../src/shared/application/payload-hash.ts';
import { InvalidPayloadError } from '../../../src/shared/interface/invalid-payload.error.ts';
import { parseWagerTransactionMessage } from '../../../src/wagering/interface/wager-transaction.message.ts';

const data = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  idempotencyKey: 'provider-a:transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

function envelope(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    messageId: 'msg-123',
    type: 'WagerTransactionRequested',
    occurredAt: '2026-07-29T15:00:00.000Z',
    data,
    ...overrides,
  });
}

describe('parseWagerTransactionMessage', () => {
  test('reads the command from data, key included, and the inbox entry from the envelope', () => {
    const message = parseWagerTransactionMessage(envelope(), {});

    expect(message.messageId).toBe('msg-123');
    expect(message.payloadHash).toBe(hashPayload(data));
    expect(message.command).toEqual({
      idempotencyKey: 'provider-a:transaction-123',
      correlationId: 'msg-123',
      providerId: 'provider-a',
      externalTransactionId: 'transaction-123',
      playerId: data.playerId,
      walletId: data.walletId,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
      referenceExternalTransactionId: undefined,
    });
  });

  test('the correlationId attribute, when present, is the correlation id', () => {
    const message = parseWagerTransactionMessage(envelope(), { correlationId: 'corr-1' });

    expect(message.command.correlationId).toBe('corr-1');
  });

  test.each(['2026-07-29T15:00:00Z', '2026-07-29T12:00:00.5-03:00'])('accepts occurredAt %s', (occurredAt) => {
    expect(parseWagerTransactionMessage(envelope({ occurredAt }), {}).messageId).toBe('msg-123');
  });

  test('keeps the reference of a dependent transaction', () => {
    const withReference = { ...data, kind: 'REFUND', referenceExternalTransactionId: 'bet-1' };

    const message = parseWagerTransactionMessage(envelope({ data: withReference }), {});

    expect(message.command.referenceExternalTransactionId).toBe('bet-1');
  });

  test.each([
    ['a body that is not JSON', '{'],
    ['an envelope without messageId', envelope({ messageId: undefined })],
    ['an empty messageId', envelope({ messageId: '' })],
    ['an unknown envelope field', envelope({ extra: 1 })],
    ['data without idempotencyKey', envelope({ data: { ...data, idempotencyKey: undefined } })],
    ['an unknown data field', envelope({ data: { ...data, channel: 'SQS' } })],
    ['money that is not an object', envelope({ data: { ...data, money: '25.00' } })],
    ['a type other than WagerTransactionRequested', envelope({ type: 'Foo' })],
    ['a type that is not a string', envelope({ type: 1 })],
    ['an occurredAt that is a number', envelope({ occurredAt: 42 })],
    ['an occurredAt that is not ISO-8601', envelope({ occurredAt: 'yesterday' })],
    ['an occurredAt without a time zone', envelope({ occurredAt: '2026-07-29T15:00:00' })],
    ['an occurredAt that is not a real date', envelope({ occurredAt: '2026-02-30T15:00:00Z' })],
  ])('refuses %s', (_case, body) => {
    expect(() => parseWagerTransactionMessage(body, {})).toThrow(InvalidPayloadError);
  });
});
