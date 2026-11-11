/**
 * The reconciliation query (ADR 0003): one read-only SQL statement — one
 * snapshot, no lock — that returns the wallet's stored balance, the signed sum
 * of its entries (credit +, debit −), their count and the gaps in the version
 * sequence. Sums run over the `numeric` columns in SQL; amounts leave as text.
 *
 * Versions 2 up to the wallet's current version must each have an entry;
 * version 1 only exists with an opening, so a missing opening shows up as a
 * difference, not as a gap. Also run by the integration tests' final invariant
 * check, which is why the placeholder syntax is a parameter.
 *
 * @packageDocumentation
 */

/** One row per wallet found; none when the wallet does not exist. */
export interface ReconciliationRow {
  wallet_id: string;
  currency: string;
  stored_balance: string;
  calculated_balance: string;
  difference: string;
  checked_entries: number;
  version_gaps: { from: number; to: number }[];
}

/**
 * @param walletIdPlaceholder - How the driver spells the single wallet id
 *   parameter: `?` for MikroORM, `$1` for Bun's SQL.
 * @returns The query text.
 */
export function reconciliationQuery(walletIdPlaceholder: string): string {
  return `
    with wallet as (
      select id, balance_amount, balance_currency, version
        from wallets
       where id = ${walletIdPlaceholder}
    ),
    entries as (
      select e.wallet_version,
             case e.direction when 'CREDIT' then e.amount else -e.amount end as signed_amount
        from wallet_ledger_entries e
        join wallet w on w.id = e.wallet_id
    ),
    totals as (
      select coalesce(sum(signed_amount), 0)::numeric(19, 2) as calculated, count(*)::int as checked
        from entries
    ),
    missing as (
      select v
        from wallet w, generate_series(2, w.version) as v
       where not exists (select 1 from entries e where e.wallet_version = v)
    ),
    gaps as (
      select min(v) as from_version, max(v) as to_version
        from (select v, v - row_number() over (order by v) as island from missing) islands
       group by island
    )
    select w.id as wallet_id,
           w.balance_currency as currency,
           w.balance_amount::text as stored_balance,
           t.calculated::text as calculated_balance,
           (w.balance_amount - t.calculated)::text as difference,
           t.checked as checked_entries,
           coalesce(
             (select json_agg(json_build_object('from', from_version, 'to', to_version) order by from_version)
                from gaps),
             '[]'::json
           ) as version_gaps
      from wallet w cross join totals t
  `;
}
