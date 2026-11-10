/**
 * Unit tests for `WagerTransaction`: creation and the `create` → `markProcessed`
 * transition the opening follows.
 *
 * @packageDocumentation
 */
import { describe, expect, test } from 'bun:test';
import { Money } from '../../../src/shared/domain/money.ts';
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  type CreateWagerTransactionProps,
} from '../../../src/wagering/domain/wager-transaction.ts';

const WALLET_ID = '0192f291-27dd-7d3f-8071-5f8685deef37';
const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

const opening = (overrides: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps => ({
  id: '0192f291-27dd-7d3f-8071-5f8685deef38',
  providerId: 'internal',
  externalTransactionId: `opening:${WALLET_ID}`,
  idempotencyKey: `opening:${WALLET_ID}`,
  payloadHash: 'a'.repeat(64),
  walletId: WALLET_ID,
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  roundId: 'opening',
  gameId: 'opening',
  kind: WagerTransactionKind.Opening,
  money: brl('100.00'),
  correlationId: 'corr-1',
  ...overrides,
});

describe('WagerTransaction.create', () => {
  test('is born PENDING, with nothing of an outcome yet', () => {
    const transaction = WagerTransaction.create(opening());

    expect(transaction.status).toBe(WagerTransactionStatus.Pending);
    expect(transaction.kind).toBe(WagerTransactionKind.Opening);
    expect(transaction.correlationId).toBe('corr-1');
    expect(transaction.isTerminal()).toBe(false);
    expect(transaction.processedAt).toBeUndefined();
    expect(transaction.balanceAfter).toBeUndefined();
    expect(transaction.walletVersionObserved).toBeUndefined();
    expect(transaction.referenceTransactionId).toBeUndefined();
    expect(transaction.failureCode).toBeUndefined();
  });

  test('refuses a zero amount on a kind that moves the balance', () => {
    expect(() => WagerTransaction.create(opening({ money: brl('0.00') }))).toThrow(
      InvalidWagerTransactionError,
    );
  });

  test.each([
    ['an OPENING with a reference', opening({ referenceExternalTransactionId: 'bet-1' })],
    ['a REFUND without a reference', opening({ kind: WagerTransactionKind.Refund })],
    ['a ROLLBACK without a reference', opening({ kind: WagerTransactionKind.Rollback })],
  ])('refuses %s', (_case, props) => {
    expect(() => WagerTransaction.create(props)).toThrow(InvalidWagerTransactionError);
  });
});

describe('WagerTransaction.markProcessed', () => {
  test('records when it was applied and the balance and version it left', () => {
    const transaction = WagerTransaction.create(opening());
    const at = new Date('2026-11-10T10:00:00Z');

    transaction.markProcessed({ at, balanceAfter: brl('100.00'), walletVersionObserved: 1 });

    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(transaction.isTerminal()).toBe(true);
    expect(transaction.processedAt).toEqual(at);
    expect(transaction.balanceAfter?.equals(brl('100.00'))).toBe(true);
    expect(transaction.walletVersionObserved).toBe(1);
  });

  test('a processed transaction is terminal: processing it again is a programming error', () => {
    const transaction = WagerTransaction.create(opening());
    const outcome = { at: new Date(), balanceAfter: brl('100.00'), walletVersionObserved: 1 };
    transaction.markProcessed(outcome);

    expect(() => transaction.markProcessed(outcome)).toThrow(InvalidTransactionStateError);
  });
});
