/**
 * The ledger cursor: what it encodes, and every way a cursor is refused.
 *
 * @packageDocumentation
 */
import { describe, expect, test } from 'bun:test';
import { decodeLedgerCursor, encodeLedgerCursor } from '../../../src/wallet/application/ledger-cursor.ts';
import { InvalidCursorError } from '../../../src/wallet/application/wallet-errors.ts';

const walletId = '0192f291-27dd-7d3f-8071-5f8685deef37';
const raw = (text: string): string => Buffer.from(text).toString('base64url');

describe('ledger cursor', () => {
  test('is base64url of v1:<walletId>:<wallet_version>', () => {
    expect(encodeLedgerCursor(walletId, 42)).toBe(raw(`v1:${walletId}:42`));
  });

  test('decodes back to the wallet version, whatever the case of the wallet id', () => {
    const cursor = encodeLedgerCursor(walletId.toUpperCase(), 7);

    expect(decodeLedgerCursor(cursor, walletId)).toBe(7);
    expect(decodeLedgerCursor(cursor, walletId.toUpperCase())).toBe(7);
  });

  test.each([
    ['empty', ''],
    ['not base64url', 'a+b/'],
    ['padded', `${raw(`v1:${walletId}:1`)}=`],
    ['another prefix', raw(`v2:${walletId}:1`)],
    ['extra fields', raw(`v1:${walletId}:1:2`)],
    ['version 0', raw(`v1:${walletId}:0`)],
    ['leading zero', raw(`v1:${walletId}:01`)],
    ['over the integer column', raw(`v1:${walletId}:2147483648`)],
    ['another wallet', raw('v1:0192f291-27dd-7d3f-8071-000000000000:1')],
  ])('%s → InvalidCursorError', (_case, cursor) => {
    expect(() => decodeLedgerCursor(cursor, walletId)).toThrow(InvalidCursorError);
  });
});
