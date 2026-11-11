/**
 * The ledger page cursor (ADR 0003): opaque to the client,
 * `base64url("v1:<walletId>:<wallet_version>")`, pointing at the last entry
 * served. The only place that encodes or reads it; the `v1` prefix versions the
 * format.
 *
 * @packageDocumentation
 */
import { InvalidCursorError } from './wallet-errors.ts';

const CURSOR_VERSION = 'v1';
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
// Wallet versions are `integer` columns, from 1.
const WALLET_VERSION_PATTERN = /^[1-9]\d{0,9}$/;
const MAX_WALLET_VERSION = 2_147_483_647;

/**
 * @param walletId - The wallet the page belongs to.
 * @param walletVersion - The version of the last entry served.
 * @returns The opaque cursor of the next page.
 */
export function encodeLedgerCursor(walletId: string, walletVersion: number): string {
  return Buffer.from(`${CURSOR_VERSION}:${walletId.toLowerCase()}:${walletVersion}`).toString('base64url');
}

/**
 * @param cursor - The cursor the client sent back.
 * @param walletId - The wallet being paged; the cursor must be of this wallet.
 * @returns The version of the last entry already served.
 * @throws {@link InvalidCursorError} If the cursor is not valid base64url, has
 *   another format version, a non-integer version, or belongs to another wallet.
 */
export function decodeLedgerCursor(cursor: string, walletId: string): number {
  if (!BASE64URL_PATTERN.test(cursor)) throw new InvalidCursorError('cursor is not base64url');
  const decoded = Buffer.from(cursor, 'base64url');
  // Rejects the trailing bits a lenient decoder would silently drop.
  if (decoded.toString('base64url') !== cursor) throw new InvalidCursorError('cursor is not base64url');
  const [version, cursorWalletId, walletVersion, ...rest] = decoded.toString('utf8').split(':');
  if (version !== CURSOR_VERSION || rest.length > 0) throw new InvalidCursorError('unknown cursor format');
  if (cursorWalletId !== walletId.toLowerCase()) throw new InvalidCursorError('cursor belongs to another wallet');
  if (walletVersion === undefined || !WALLET_VERSION_PATTERN.test(walletVersion)) {
    throw new InvalidCursorError('cursor has no valid wallet version');
  }
  const parsed = Number(walletVersion);
  if (parsed > MAX_WALLET_VERSION) throw new InvalidCursorError('cursor has no valid wallet version');
  return parsed;
}
