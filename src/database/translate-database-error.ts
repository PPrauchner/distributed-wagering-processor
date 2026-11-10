/**
 * Translates database errors into application errors. Today it knows one case,
 * the one-wallet-per-player-and-currency uniqueness; it is the seam the single
 * database error classifier (ADR 0001) will grow from.
 *
 * @packageDocumentation
 */
import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { DuplicateWalletError } from '../wallet/application/wallet-errors.ts';

const WALLET_PER_PLAYER_AND_CURRENCY = 'wallets_player_currency_unique';

/**
 * @param error - Whatever the unit of work threw.
 * @returns The application error it means, or the error itself when unknown.
 */
export function translateDatabaseError(error: unknown): unknown {
  if (
    error instanceof UniqueConstraintViolationException &&
    violatedConstraint(error) === WALLET_PER_PLAYER_AND_CURRENCY
  ) {
    return new DuplicateWalletError(error.message);
  }
  return error;
}

// The driver error copies the PostgreSQL error's own fields, `constraint` included.
function violatedConstraint(error: Error): string | undefined {
  const constraint: unknown = Reflect.get(error, 'constraint');
  return typeof constraint === 'string' ? constraint : undefined;
}
