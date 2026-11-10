/**
 * Carteira do spike: classe de domínio pura, sem decorators e sem import de ORM ou
 * NestJS, com construtor privado e estado encapsulado — o formato que o domínio
 * real vai usar.
 *
 * @packageDocumentation
 */

export class InsufficientFundsError extends Error {
  constructor() {
    super('INSUFFICIENT_FUNDS');
  }
}

const SCALE = 100n;

function toCents(amount: string): bigint {
  const match = /^(\d+)\.(\d{2})$/.exec(amount);
  if (!match) throw new Error(`invalid amount: ${amount}`);
  return BigInt(match[1]!) * SCALE + BigInt(match[2]!);
}

function fromCents(cents: bigint): string {
  const whole = cents / SCALE;
  const fraction = (cents % SCALE).toString().padStart(2, '0');
  return `${whole}.${fraction}`;
}

export class SpikeWallet {
  private constructor(
    public readonly id: string,
    private _balance: string,
    private _version: number,
  ) {}

  static open(id: string, initialBalance: string): SpikeWallet {
    toCents(initialBalance);
    return new SpikeWallet(id, initialBalance, 1);
  }

  get balance(): string {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  debit(amount: string): void {
    const next = toCents(this._balance) - toCents(amount);
    if (next < 0n) throw new InsufficientFundsError();
    this._balance = fromCents(next);
    this._version += 1;
  }
}
