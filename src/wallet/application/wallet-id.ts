/**
 * The shape of a wallet id, checked before any lookup.
 *
 * @packageDocumentation
 */
import { isUuid } from '../../shared/application/uuid.ts';

/** @returns Whether `walletId` could be the id of a wallet. */
export function isWalletIdFormat(walletId: string): boolean {
  // Wallet ids are UUIDs; anything else cannot exist and never reaches the database.
  return isUuid(walletId);
}
