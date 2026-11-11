/**
 * Errors the wallet use cases raise to their callers.
 *
 * @packageDocumentation
 */

/** The player already has a wallet in that currency. */
export class WalletAlreadyExistsError extends Error {
  override readonly name = 'WalletAlreadyExistsError';

  constructor(readonly walletId: string) {
    super(`a wallet for this player and currency already exists: ${walletId}`);
  }
}

/** The creation came with an `Idempotency-Key` header, but an empty one. */
export class EmptyCreationKeyError extends Error {
  override readonly name = 'EmptyCreationKeyError';

  constructor() {
    super('the Idempotency-Key header is optional, but must not be empty when present');
  }
}

/** The creation key was already used with another payload. */
export class WalletCreationConflictError extends Error {
  override readonly name = 'WalletCreationConflictError';

  constructor(idempotencyKey: string) {
    super(`idempotency key "${idempotencyKey}" already created a wallet with another payload`);
  }
}

export class WalletNotFoundError extends Error {
  override readonly name = 'WalletNotFoundError';

  constructor(walletId: string) {
    super(`wallet not found: ${walletId}`);
  }
}

/**
 * Raised by the unit of work when the commit hits the one-wallet-per-player-and-
 * currency uniqueness: a concurrent creation won the race. It carries no wallet
 * id; the use case reads the winner back.
 */
export class DuplicateWalletError extends Error {
  override readonly name = 'DuplicateWalletError';
}

/**
 * Raised by the unit of work when the commit hits the creation key's
 * uniqueness: a concurrent creation with the same key won the race. The use
 * case reads it back — replay or conflict.
 */
export class DuplicateWalletCreationKeyError extends Error {
  override readonly name = 'DuplicateWalletCreationKeyError';
}

/** A ledger cursor that the API did not hand out for this wallet. */
export class InvalidCursorError extends Error {
  override readonly name = 'InvalidCursorError';
}
