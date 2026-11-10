/**
 * Unit tests for `WalletLedgerEntry`: the factory checks the entry's arithmetic.
 *
 * @packageDocumentation
 */
import { describe, expect, test } from 'bun:test';
import { Money } from '../../../src/shared/domain/money.ts';
import {
  InvalidLedgerEntryError,
  LedgerDirection,
  WalletLedgerEntry,
  type CreateLedgerEntryProps,
} from '../../../src/wallet/domain/wallet-ledger-entry.ts';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

const credit = (overrides: Partial<CreateLedgerEntryProps> = {}): CreateLedgerEntryProps => ({
  id: '0192f291-27dd-7d3f-8071-5f8685deef40',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  transactionId: '0192f291-27dd-7d3f-8071-5f8685deef38',
  direction: LedgerDirection.Credit,
  money: brl('30.00'),
  balanceBefore: brl('100.00'),
  balanceAfter: brl('130.00'),
  walletVersion: 2,
  createdAt: new Date('2026-11-10T10:00:00Z'),
  ...overrides,
});

describe('WalletLedgerEntry.create', () => {
  test('a credit adds the amount to the balance', () => {
    const entry = WalletLedgerEntry.create(credit());

    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceAfter.equals(brl('130.00'))).toBe(true);
    expect(entry.walletVersion).toBe(2);
    expect(entry.isBalanced()).toBe(true);
  });

  test('a debit subtracts the amount from the balance', () => {
    const entry = WalletLedgerEntry.create(
      credit({ direction: LedgerDirection.Debit, balanceAfter: brl('70.00') }),
    );

    expect(entry.isBalanced()).toBe(true);
  });

  test.each([
    ['a credit whose balance after does not add up', credit({ balanceAfter: brl('129.99') })],
    ['a debit written as a credit', credit({ direction: LedgerDirection.Debit })],
    ['a zero amount', credit({ money: brl('0.00'), balanceAfter: brl('100.00') })],
    [
      'a debit below zero',
      credit({
        direction: LedgerDirection.Debit,
        balanceBefore: brl('10.00'),
        balanceAfter: brl('10.00').subtract(brl('30.00')),
      }),
    ],
    [
      'an amount in another currency',
      credit({ money: Money.from({ amount: '30.00', currency: 'USD' }) }),
    ],
    ['a wallet version below 1', credit({ walletVersion: 0 })],
    ['a fractional wallet version', credit({ walletVersion: 1.5 })],
  ])('refuses %s', (_case, props) => {
    expect(() => WalletLedgerEntry.create(props)).toThrow(InvalidLedgerEntryError);
  });
});

describe('WalletLedgerEntry.rehydrate', () => {
  test('rebuilds persisted state as is', () => {
    const state = credit();

    const entry = WalletLedgerEntry.rehydrate(state);

    expect(entry.id).toBe(state.id);
    expect(entry.transactionId).toBe(state.transactionId);
    expect(entry.money.equals(state.money)).toBe(true);
    expect(entry.balanceBefore.equals(state.balanceBefore)).toBe(true);
    expect(entry.createdAt).toEqual(state.createdAt);
  });
});
