/**
 * `Money` value object: an exact amount in one currency.
 *
 * The amount is kept as the exact decimal string that goes to the
 * `numeric(19,2)` column; arithmetic converts it to integer cents in `bigint`.
 * `number` never touches money, and nothing is ever rounded.
 *
 * @packageDocumentation
 */

/** Wire format of a money value: decimal string with 2 places plus currency. */
export interface MoneyProps {
  amount: string;
  currency: string;
}

/** Raised when an amount or currency does not follow the money contract. */
export class InvalidMoneyError extends Error {
  override readonly name = 'InvalidMoneyError';
}

/** Raised when two money values of different currencies are combined. */
export class CurrencyMismatchError extends Error {
  override readonly name = 'CurrencyMismatchError';
}

// Up to 15 integer digits, no leading zeros, exactly 2 decimal places. Rejects
// NaN, Infinity, scientific notation, signs and anything that would need rounding.
const AMOUNT_PATTERN = /^(0|[1-9]\d{0,14})\.\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
// Arithmetic results are already canonical, so only the shape is checked here.
const SIGNED_AMOUNT_PATTERN = /^(-?)(\d+)\.(\d{2})$/;
const CENTS_PER_UNIT = 100n;

function toCents(amount: string): bigint {
  const match = SIGNED_AMOUNT_PATTERN.exec(amount);
  if (!match) throw new InvalidMoneyError(`not a decimal amount: "${amount}"`);
  const [, sign, units, cents] = match;
  const magnitude = BigInt(units!) * CENTS_PER_UNIT + BigInt(cents!);
  return sign === '-' ? -magnitude : magnitude;
}

function fromCents(cents: bigint): string {
  const sign = cents < 0n ? '-' : '';
  const magnitude = cents < 0n ? -cents : cents;
  const units = magnitude / CENTS_PER_UNIT;
  const fraction = (magnitude % CENTS_PER_UNIT).toString().padStart(2, '0');
  return `${sign}${units}.${fraction}`;
}

function assertCurrency(currency: string): void {
  if (!CURRENCY_PATTERN.test(currency)) {
    throw new InvalidMoneyError(`currency must be 3 uppercase letters, got "${currency}"`);
  }
}

export class Money {
  // Only assigns: the ORM's metadata discovery calls `new Money()` with no
  // arguments (ADR 0001), so validation lives in the factories.
  private constructor(
    private readonly _amount: string,
    readonly currency: string,
  ) {}

  /**
   * Builds a money value from its wire format. Negative amounts are refused:
   * no input contract accepts them; they only arise from arithmetic.
   *
   * @param props - Decimal string amount and currency code.
   * @returns The money value.
   * @throws {@link InvalidMoneyError} If the amount or the currency is malformed.
   */
  static from(props: MoneyProps): Money {
    if (!AMOUNT_PATTERN.test(props.amount)) {
      throw new InvalidMoneyError(
        `amount must be a non-negative decimal string with exactly 2 places and at most 15 integer digits, got "${props.amount}"`,
      );
    }
    assertCurrency(props.currency);
    return new Money(props.amount, props.currency);
  }

  /**
   * Builds a money value read back from the database: a column value or the
   * result of SQL arithmetic over them. Internal — never for input: it skips
   * the 15-digit input ceiling and accepts a negative amount, so a balance past
   * the input ceiling, up to the wallet's maximum balance, still reads back.
   *
   * @param props - Canonical decimal string amount, maybe negative, and currency code.
   * @returns The money value.
   * @throws {@link InvalidMoneyError} If the amount or the currency is malformed.
   */
  static fromPersisted(props: MoneyProps): Money {
    assertCurrency(props.currency);
    return new Money(fromCents(toCents(props.amount)), props.currency);
  }

  /**
   * @param currency - Three-letter currency code.
   * @returns The zero amount in that currency.
   * @throws {@link InvalidMoneyError} If the currency is malformed.
   */
  static zero(currency: string): Money {
    assertCurrency(currency);
    return new Money('0.00', currency);
  }

  /** @throws {@link CurrencyMismatchError} If the currencies differ. */
  add(other: Money): Money {
    this.assertSameCurrency(other);
    return this.withCents(this.cents() + other.cents());
  }

  /** @throws {@link CurrencyMismatchError} If the currencies differ. */
  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return this.withCents(this.cents() - other.cents());
  }

  negate(): Money {
    return this.withCents(-this.cents());
  }

  isZero(): boolean {
    return this.cents() === 0n;
  }

  isPositive(): boolean {
    return this.cents() > 0n;
  }

  isNegative(): boolean {
    return this.cents() < 0n;
  }

  /** @throws {@link CurrencyMismatchError} If the currencies differ. */
  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents() < other.cents();
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.cents() === other.cents();
  }

  toJSON(): MoneyProps {
    return { amount: this._amount, currency: this.currency };
  }

  toString(): string {
    return `${this._amount} ${this.currency}`;
  }

  private cents(): bigint {
    return toCents(this._amount);
  }

  private withCents(cents: bigint): Money {
    return new Money(fromCents(cents), this.currency);
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(
        `cannot combine ${this.currency} with ${other.currency}`,
      );
    }
  }
}
