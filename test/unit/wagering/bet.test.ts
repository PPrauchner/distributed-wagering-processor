/**
 * Unit tests for the `BET` rules: the outcome of a bet on its wallet, with the
 * domain checks in their documented order (`ARCHITECTURE.md` § Ordem das
 * validações, step 8).
 *
 * @packageDocumentation
 */
import { describe, expect, test } from 'bun:test';
import { FailureCode } from '../../../src/shared/domain/failure-code.ts';
import { Money } from '../../../src/shared/domain/money.ts';
import { applyBet } from '../../../src/wagering/domain/bet.ts';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  type CreateWagerTransactionProps,
} from '../../../src/wagering/domain/wager-transaction.ts';
import { Wallet } from '../../../src/wallet/domain/wallet.ts';
import { LedgerDirection } from '../../../src/wallet/domain/wallet-ledger-entry.ts';

const WALLET_ID = '0192f291-27dd-7d3f-8071-5f8685deef37';
const PLAYER_ID = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
const ENTRY_ID = '0192f299-0000-7000-8000-000000000001';
const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string): Money => Money.from({ amount, currency: 'USD' });

const bet = (overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction =>
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
    kind: WagerTransactionKind.Bet,
    money: brl('80.00'),
    correlationId: 'corr-1',
    ...overrides,
  });

const walletWith = (balance: Money): Wallet =>
  Wallet.open({ id: WALLET_ID, playerId: PLAYER_ID, initialBalance: balance });

describe('applyBet', () => {
  test('with funds: debits, bumps the version and processes the bet with the balance it left', () => {
    const wallet = walletWith(brl('100.00'));
    const transaction = bet();

    const entry = applyBet(transaction, wallet, { entryId: ENTRY_ID });

    expect(wallet.balance.equals(brl('20.00'))).toBe(true);
    expect(wallet.version).toBe(2);
    expect(entry?.direction).toBe(LedgerDirection.Debit);
    expect(entry?.id).toBe(ENTRY_ID);
    expect(entry?.transactionId).toBe(transaction.id);
    expect(entry?.walletVersion).toBe(2);
    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(transaction.balanceAfter?.equals(brl('20.00'))).toBe(true);
    expect(transaction.walletVersionObserved).toBe(2);
    expect(transaction.processedAt).toEqual(entry!.createdAt);
  });

  test('a bet of the whole balance is processed', () => {
    const wallet = walletWith(brl('80.00'));
    const transaction = bet();

    applyBet(transaction, wallet, { entryId: ENTRY_ID });

    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(wallet.balance.isZero()).toBe(true);
  });

  test('without funds: rejected INSUFFICIENT_FUNDS, the wallet untouched and its balance observed', () => {
    const wallet = walletWith(brl('50.00'));
    const transaction = bet();

    const entry = applyBet(transaction, wallet, { entryId: ENTRY_ID });

    expect(entry).toBeUndefined();
    expect(wallet.balance.equals(brl('50.00'))).toBe(true);
    expect(wallet.version).toBe(1);
    expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(transaction.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(transaction.balanceAfter?.equals(brl('50.00'))).toBe(true);
    expect(transaction.walletVersionObserved).toBe(1);
  });

  test('in another currency: rejected CURRENCY_MISMATCH, observing the balance in the wallet currency', () => {
    const wallet = walletWith(brl('100.00'));
    const transaction = bet({ money: usd('10.00') });

    const entry = applyBet(transaction, wallet, { entryId: ENTRY_ID });

    expect(entry).toBeUndefined();
    expect(transaction.failureCode).toBe(FailureCode.CurrencyMismatch);
    expect(transaction.balanceAfter?.equals(brl('100.00'))).toBe(true);
    expect(wallet.version).toBe(1);
  });

  test("on another player's wallet: rejected WALLET_PLAYER_MISMATCH", () => {
    const wallet = walletWith(brl('100.00'));
    const transaction = bet({ playerId: 'someone-else' });

    const entry = applyBet(transaction, wallet, { entryId: ENTRY_ID });

    expect(entry).toBeUndefined();
    expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(transaction.failureCode).toBe(FailureCode.WalletPlayerMismatch);
    expect(wallet.balance.equals(brl('100.00'))).toBe(true);
  });

  test.each([
    ['player, currency and funds', { playerId: 'someone-else', money: usd('500.00') }, FailureCode.WalletPlayerMismatch],
    ['currency and funds', { money: usd('500.00') }, FailureCode.CurrencyMismatch],
  ])('with several violations (%s), the first in order wins', (_case, overrides, code) => {
    const transaction = bet(overrides);

    applyBet(transaction, walletWith(brl('100.00')), { entryId: ENTRY_ID });

    expect(transaction.failureCode).toBe(code);
  });

  test('is only for a BET', () => {
    const transaction = bet({ kind: WagerTransactionKind.Loss });

    expect(() => applyBet(transaction, walletWith(brl('100.00')), { entryId: ENTRY_ID })).toThrow();
  });
});
