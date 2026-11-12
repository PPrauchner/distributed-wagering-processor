/**
 * Unit tests for the HTTP request parsing of a wager transaction submission:
 * the `Idempotency-Key` header, checked before the body.
 *
 * @packageDocumentation
 */
import { describe, expect, test } from 'bun:test';
import { MissingIdempotencyKeyError } from '../../../src/wagering/application/wagering-errors.ts';
import { parseSubmitWagerTransactionRequest } from '../../../src/wagering/interface/wager-transaction.http.ts';

const body = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

describe('parseSubmitWagerTransactionRequest', () => {
  test.each([
    ['absent', undefined],
    ['empty', ''],
    ['only spaces', '   '],
    ['only whitespace', ' \t '],
  ])('refuses an Idempotency-Key %s', (_case, idempotencyKey) => {
    expect(() => parseSubmitWagerTransactionRequest(body, { idempotencyKey })).toThrow(MissingIdempotencyKeyError);
  });

  test('trims the Idempotency-Key', () => {
    const command = parseSubmitWagerTransactionRequest(body, { idempotencyKey: '  key-1  ' });

    expect(command.idempotencyKey).toBe('key-1');
  });
});
