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

export class WalletNotFoundError extends Error {
  override readonly name = 'WalletNotFoundError';

  constructor(walletId: string) {
    super(`wallet not found: ${walletId}`);
  }
}

/**
 * A positive initial balance needs the opening transaction and its ledger
 * entry, which do not exist yet: no wallet ever holds a balance without one.
 */
export class UnsupportedInitialBalanceError extends Error {
  override readonly name = 'UnsupportedInitialBalanceError';

  constructor() {
    super('a positive initial balance is not supported yet; create the wallet with "0.00"');
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
