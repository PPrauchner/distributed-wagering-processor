/**
 * The shape of a wallet id, checked before any lookup.
 *
 * @packageDocumentation
 */

// Wallet ids are UUIDs; anything else cannot exist and never reaches the database.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** @returns Whether `walletId` could be the id of a wallet. */
export function isWalletIdFormat(walletId: string): boolean {
  return UUID_PATTERN.test(walletId);
}
