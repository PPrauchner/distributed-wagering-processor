/**
 * Unit tests for the hash of a wager transaction's payload: exactly the
 * business fields enter it (`ARCHITECTURE.md` § Hash do payload).
 *
 * @packageDocumentation
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { Money } from '../../../src/shared/domain/money.ts';
import { hashWagerPayload, type WagerPayload } from '../../../src/wagering/application/wager-payload.ts';
import { WagerTransactionKind } from '../../../src/wagering/domain/wager-transaction.ts';

const payload: WagerPayload = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: WagerTransactionKind.Bet,
  money: Money.from({ amount: '25.00', currency: 'BRL' }),
};

describe('hashWagerPayload', () => {
  test('is the SHA-256 of the documented canonical JSON', () => {
    const canonical =
      '{"externalTransactionId":"transaction-123","gameId":"fortune-chimp","kind":"BET",' +
      '"money":{"amount":"25.00","currency":"BRL"},"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",' +
      '"providerId":"provider-a","roundId":"round-987","walletId":"0192f291-27dd-7d3f-8071-5f8685deef37"}';

    expect(hashWagerPayload(payload)).toBe(createHash('sha256').update(canonical, 'utf8').digest('hex'));
    expect(hashWagerPayload(payload)).toMatch(/^[0-9a-f]{64}$/);
  });

  test.each<[string, Partial<WagerPayload>]>([
    ['providerId', { providerId: 'provider-b' }],
    ['externalTransactionId', { externalTransactionId: 'transaction-124' }],
    ['playerId', { playerId: 'other-player' }],
    ['walletId', { walletId: '0192f291-27dd-7d3f-8071-5f8685deef38' }],
    ['roundId', { roundId: 'round-988' }],
    ['gameId', { gameId: 'other-game' }],
    ['kind', { kind: WagerTransactionKind.Win }],
    ['money.amount', { money: Money.from({ amount: '25.01', currency: 'BRL' }) }],
    ['money.currency', { money: Money.from({ amount: '25.00', currency: 'USD' }) }],
    ['referenceExternalTransactionId', { referenceExternalTransactionId: 'transaction-100' }],
  ])('the included field %s changes the hash', (_field, change) => {
    expect(hashWagerPayload({ ...payload, ...change })).not.toBe(hashWagerPayload(payload));
  });

  test.each([
    ['the idempotency key', { idempotencyKey: 'provider-a:transaction-123' }],
    ['the correlation id', { correlationId: 'corr-1' }],
    ['the message id', { messageId: 'message-1' }],
    ['the message type', { type: 'wagering.transaction.submitted' }],
    ['occurredAt', { occurredAt: '2026-11-10T10:00:00Z' }],
    ['the channel', { channel: 'http' }],
  ])('the excluded field %s leaves the hash alone', (_field, extra) => {
    const withTransport: WagerPayload = { ...payload, ...extra };

    expect(hashWagerPayload(withTransport)).toBe(hashWagerPayload(payload));
  });

  test('an absent reference is omitted, never hashed as null', () => {
    expect(hashWagerPayload({ ...payload, referenceExternalTransactionId: undefined })).toBe(
      hashWagerPayload(payload),
    );
  });
});
