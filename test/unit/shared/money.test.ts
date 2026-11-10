/**
 * Unit tests for the `Money` value object: exact decimal amounts, fixed scale,
 * strict input validation and currency safety.
 *
 * @packageDocumentation
 */
import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError, Money } from '../../../src/shared/domain/money.ts';

describe('Money.from', () => {
  test('keeps the decimal string and currency exactly as received', () => {
    const money = Money.from({ amount: '25.00', currency: 'BRL' });

    expect(money.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
  });

  test.each([
    ['NaN'],
    ['Infinity'],
    ['-Infinity'],
    ['1e2'],
    ['1.5e2'],
    [''],
    [' 1.00'],
    ['1'],
    ['1.0'],
    ['1.234'],
    ['.50'],
    ['1,00'],
    ['+1.00'],
    ['01.00'],
    ['1000000000000000.00'], // 16 integer digits
  ])('rejects the malformed amount %p', (amount) => {
    expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  test('rejects a negative amount', () => {
    expect(() => Money.from({ amount: '-1.00', currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  test.each([['brl'], ['BR'], ['BRLX'], [''], ['B1L']])(
    'rejects the malformed currency %p',
    (currency) => {
      expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
    },
  );

  test('accepts the 15-integer-digit ceiling without losing precision', () => {
    const money = Money.from({ amount: '999999999999999.99', currency: 'BRL' });

    expect(money.toString()).toBe('999999999999999.99 BRL');
  });
});

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

describe('arithmetic', () => {
  test('adds exactly, where binary floating point would drift', () => {
    expect(brl('0.10').add(brl('0.20')).toJSON().amount).toBe('0.30');
  });

  test('adds at the 15-digit ceiling without losing cents', () => {
    expect(brl('999999999999999.99').add(brl('0.01')).toJSON().amount).toBe(
      '1000000000000000.00',
    );
  });

  test('subtracts down to a negative result with fixed scale', () => {
    expect(brl('1.00').subtract(brl('1.05')).toJSON().amount).toBe('-0.05');
    expect(brl('100.00').subtract(brl('80.00')).toJSON().amount).toBe('20.00');
  });

  test('negates, and negating zero stays zero', () => {
    expect(brl('12.34').negate().toJSON().amount).toBe('-12.34');
    expect(brl('12.34').negate().negate().toJSON().amount).toBe('12.34');
    expect(Money.zero('BRL').negate().toJSON().amount).toBe('0.00');
  });

  test('never mutates the operands', () => {
    const left = brl('10.00');
    const right = brl('3.00');

    left.add(right);
    left.subtract(right);
    left.negate();

    expect(left.toJSON().amount).toBe('10.00');
    expect(right.toJSON().amount).toBe('3.00');
  });

  test('operating across currencies is a domain error', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });

    expect(() => brl('1.00').add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
  });
});

describe('comparisons', () => {
  test('zero is zero in the given currency', () => {
    expect(Money.zero('USD').toJSON()).toEqual({ amount: '0.00', currency: 'USD' });
    expect(Money.zero('USD').isZero()).toBe(true);
  });

  test('zero rejects a malformed currency', () => {
    expect(() => Money.zero('usd')).toThrow(InvalidMoneyError);
  });

  test('tells the sign of an amount', () => {
    const negative = brl('0.01').negate();

    expect([brl('0.01').isPositive(), brl('0.01').isNegative(), brl('0.01').isZero()]).toEqual([
      true,
      false,
      false,
    ]);
    expect([negative.isPositive(), negative.isNegative(), negative.isZero()]).toEqual([
      false,
      true,
      false,
    ]);
    expect([brl('0.00').isPositive(), brl('0.00').isNegative()]).toEqual([false, false]);
  });

  test('orders amounts of the same currency', () => {
    expect(brl('9.99').isLessThan(brl('10.00'))).toBe(true);
    expect(brl('10.00').isLessThan(brl('10.00'))).toBe(false);
  });

  test('equals compares amount and currency', () => {
    expect(brl('10.00').equals(brl('10.00'))).toBe(true);
    expect(brl('10.00').equals(brl('10.01'))).toBe(false);
    expect(brl('10.00').equals(Money.from({ amount: '10.00', currency: 'USD' }))).toBe(false);
  });
});
