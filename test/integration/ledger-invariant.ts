/**
 * Final ledger invariant check, shared by the integration tests: for every
 * wallet a test touched, the stored balance equals the balance rebuilt from the
 * ledger, and the entries' versions run without gaps up to the wallet version —
 * from 1 with an opening, from 2 without one (ADR 0003).
 *
 * @packageDocumentation
 */
import { expect } from 'bun:test';
import type { SQL } from 'bun';

interface WalletLedgerSummary {
  id: string;
  balance: string;
  version: number;
  calculated_balance: string;
  entries: number;
  first_version: number | null;
  last_version: number | null;
}

/**
 * @param sql - Connection to the database the wallets live in.
 * @param walletIds - The wallets to check; each must exist.
 */
export async function expectLedgerConsistent(sql: SQL, walletIds: readonly string[]): Promise<void> {
  const rows: WalletLedgerSummary[] = await sql`
    select w.id,
           w.balance_amount::text as balance,
           w.version,
           coalesce(sum(case e.direction when 'CREDIT' then e.amount else -e.amount end), 0)::numeric(19, 2)::text
             as calculated_balance,
           count(e.id)::int as entries,
           min(e.wallet_version) as first_version,
           max(e.wallet_version) as last_version
      from wallets w
      left join wallet_ledger_entries e on e.wallet_id = w.id
     where w.id in ${sql(walletIds as string[])}
     group by w.id
  `;
  expect(rows.map((row) => row.id).sort()).toEqual([...walletIds].sort());

  for (const row of rows) {
    const context = `wallet ${row.id}`;
    expect(row.calculated_balance, context).toBe(row.balance);
    if (row.entries === 0) {
      expect(row.version, context).toBe(1);
      continue;
    }
    expect([1, 2], context).toContain(row.first_version!);
    expect(row.last_version, context).toBe(row.version);
    expect(row.entries, context).toBe(row.last_version! - row.first_version! + 1);
  }
}
