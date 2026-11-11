/**
 * Unit tests for the `LOSS` rules: the result of a round without a prize, which
 * never moves the balance (`CONTEXT.md` § Perda).
 *
 * @packageDocumentation
 */
import { describe, expect, test } from 'bun:test';
import { FailureCode } from '../../../src/shared/domain/failure-code.ts';
import { Money } from '../../../src/shared/domain/money.ts';
import { applyLoss } from '../../../src/wagering/domain/loss.ts';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  type CreateWagerTransactionProps,
} from '../../../src/wagering/domain/wager-transaction.ts';
import { Wallet } from '../../../src/wallet/domain/wallet.ts';

const WALLET_ID = '0192f291-27dd-7d3f-8071-5f8685deef37';
const PLAYER_ID = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string): Money => Money.from({ amount, currency: 'USD' });

const loss = (overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction =>
  WagerTransaction.create({
    id: '0192f298-345e-7e38-af88-e43f851a819d',
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    idempotencyKey: 'provider-a:transaction-123',
    payloadHash: 'a'.repeat(64),
    walletId: WALLET_ID,
    playerId: PLAYER_ID,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Loss,
    money: brl('0.00'),
    correlationId: 'corr-1',
    ...overrides,
  });

const walletWith = (balance: Money): Wallet =>
  Wallet.open({ id: WALLET_ID, playerId: PLAYER_ID, initialBalance: balance });

describe('applyLoss', () => {
  test.each(['0.00', '25.00'])(
    'of %s: processed with the balance and version observed, the wallet untouched',
    (amount) => {
      const wallet = walletWith(brl('100.00'));
      const transaction = loss({ money: brl(amount) });

      applyLoss(transaction, wallet);

      expect(transaction.status).toBe(WagerTransactionStatus.Processed);
      expect(transaction.processedAt).toBeInstanceOf(Date);
      expect(transaction.balanceAfter?.equals(brl('100.00'))).toBe(true);
      expect(transaction.walletVersionObserved).toBe(1);
      expect(wallet.balance.equals(brl('100.00'))).toBe(true);
      expect(wallet.version).toBe(1);
    },
  );

  test("on another player's wallet: rejected WALLET_PLAYER_MISMATCH, its balance observed", () => {
    const transaction = loss({ playerId: 'someone-else' });

    applyLoss(transaction, walletWith(brl('100.00')));

    expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(transaction.failureCode).toBe(FailureCode.WalletPlayerMismatch);
    expect(transaction.balanceAfter?.equals(brl('100.00'))).toBe(true);
    expect(transaction.walletVersionObserved).toBe(1);
  });

  test('in another currency: rejected CURRENCY_MISMATCH', () => {
    const transaction = loss({ money: usd('0.00') });

    applyLoss(transaction, walletWith(brl('100.00')));

    expect(transaction.failureCode).toBe(FailureCode.CurrencyMismatch);
  });

  test('another player beats another currency', () => {
    const transaction = loss({ playerId: 'someone-else', money: usd('0.00') });

    applyLoss(transaction, walletWith(brl('100.00')));

    expect(transaction.failureCode).toBe(FailureCode.WalletPlayerMismatch);
  });

  test('is only for a LOSS', () => {
    const transaction = loss({ kind: WagerTransactionKind.Bet, money: brl('1.00') });

    expect(() => applyLoss(transaction, walletWith(brl('100.00')))).toThrow();
  });
});

describe('affectsBalance', () => {
  test.each([
    [WagerTransactionKind.Loss, false],
    [WagerTransactionKind.Bet, true],
    [WagerTransactionKind.Win, true],
  ])('%s → %s', (kind, expected) => {
    const transaction = loss({ kind, money: brl('1.00') });

    expect(transaction.affectsBalance()).toBe(expected);
  });

  test('a LOSS refuses a reference', () => {
    expect(() => loss({ referenceExternalTransactionId: 'bet-1' })).toThrow();
  });

  test('a WIN refuses a zero amount', () => {
    expect(() => loss({ kind: WagerTransactionKind.Win })).toThrow();
  });
});
