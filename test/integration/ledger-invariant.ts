/**
 * Final ledger invariant check, shared by the integration and concurrency
 * tests: for every wallet a test touched, the stored balance equals the balance
 * rebuilt from the ledger, and the entries' versions run without gaps up to the
 * wallet version, and not past it —
 * from 1 with an opening, from 2 without one (ADR 0003). It runs the very query
 * of the reconciliation, so the tests and `POST /wallets/:walletId/reconciliation`
 * check the same thing.
 *
 * Besides the per-file checks, the preload runs it once more after the whole
 * run, over every wallet of the test database ({@link findInconsistentWallets});
 * a test that corrupts a wallet on purpose takes it out of that final check with
 * {@link excludeFromLedgerInvariant}.
 *
 * @packageDocumentation
 */
import { expect } from 'bun:test';
import type { SQL } from 'bun';
import { reconciliationQuery, type ReconciliationRow } from '../../src/wallet/infrastructure/reconciliation-query.ts';

const RECONCILIATION_QUERY = reconciliationQuery('$1');

/** The wallets corrupted on purpose: the final check of the run skips them. */
const excluded = new Set<string>();

/**
 * Takes a wallet a test corrupts on purpose out of the final check of the run.
 *
 * @param walletId - The wallet left inconsistent by design.
 */
export function excludeFromLedgerInvariant(walletId: string): void {
  excluded.add(walletId);
}

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

/**
 * The final check of the run: every wallet of the database but the excluded
 * ones, by the same criteria as {@link expectLedgerConsistent}.
 *
 * @param sql - Connection to the test database.
 * @returns The reconciliation of each inconsistent wallet; empty when all hold.
 */
export async function findInconsistentWallets(sql: SQL): Promise<ReconciliationRow[]> {
  const wallets: { id: string }[] = await sql`select id::text from wallets`;
  const rows = await Promise.all(
    wallets
      .filter(({ id }) => !excluded.has(id))
      .map(async ({ id }) => ((await sql.unsafe(RECONCILIATION_QUERY, [id])) as ReconciliationRow[])[0]!),
  );
  return rows.filter((row) => !isConsistent(row));
}

function isConsistent(row: ReconciliationRow): boolean {
  return (
    row.difference === '0.00' &&
    row.version_gaps.length === 0 &&
    (row.last_entry_version === null || row.last_entry_version === row.wallet_version)
  );
}
