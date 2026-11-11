/**
 * Final ledger invariant check, shared by the integration tests: for every
 * wallet a test touched, the stored balance equals the balance rebuilt from the
 * ledger, and the entries' versions run without gaps up to the wallet version, and
 * not past it —
 * from 1 with an opening, from 2 without one (ADR 0003). It runs the very query
 * of the reconciliation, so the tests and `POST /wallets/:walletId/reconciliation`
 * check the same thing.
 *
 * @packageDocumentation
 */
import { expect } from 'bun:test';
import type { SQL } from 'bun';
import { reconciliationQuery, type ReconciliationRow } from '../../src/wallet/infrastructure/reconciliation-query.ts';

const RECONCILIATION_QUERY = reconciliationQuery('$1');

/**
 * @param sql - Connection to the database the wallets live in.
 * @param walletIds - The wallets to check; each must exist.
 */
export async function expectLedgerConsistent(sql: SQL, walletIds: readonly string[]): Promise<void> {
  for (const walletId of walletIds) {
    const context = `wallet ${walletId}`;
    const rows: ReconciliationRow[] = await sql.unsafe(RECONCILIATION_QUERY, [walletId]);
    expect(rows, context).toHaveLength(1);
    const [row] = rows;
    expect(row!.difference, context).toBe('0.00');
    expect(row!.calculated_balance, context).toBe(row!.stored_balance);
    expect(row!.version_gaps, context).toEqual([]);
    if (row!.last_entry_version !== null) expect(row!.last_entry_version, context).toBe(row!.wallet_version);
  }
}
