/**
 * Creates the ledger and makes the database guarantee it (ADR 0003):
 *
 * - `wallet_ledger_entries`: at most one entry per transaction and wallet, one
 *   entry per wallet version, currency pinned to the wallet's by a composite
 *   foreign key, positive amount and the entry's arithmetic in a `CHECK`;
 * - entries are immutable: `UPDATE`, `DELETE` and `TRUNCATE` are refused;
 * - a deferred constraint trigger on `wallets` requires, at commit, an entry for
 *   every balance change — from the old balance (zero on insert) to the new one,
 *   at the new version — and the version going up by exactly 1 when the balance
 *   changes, and not at all otherwise. A wallet is born at version 1.
 *
 * @packageDocumentation
 */
import { Migration } from '@mikro-orm/migrations';

export class Migration0003WalletLedger extends Migration {
  override name = 'Migration0003WalletLedger';

  override up(): void {
    this.addSql(`
      create table wallet_ledger_entries (
        id uuid primary key,
        wallet_id uuid not null,
        transaction_id uuid not null,
        direction text not null,
        amount numeric(19, 2) not null,
        currency char(3) not null,
        balance_before_amount numeric(19, 2) not null,
        balance_before_currency char(3) not null,
        balance_after_amount numeric(19, 2) not null,
        balance_after_currency char(3) not null,
        wallet_version integer not null,
        created_at timestamptz not null,
        constraint wallet_ledger_entries_transaction_fk
          foreign key (transaction_id) references wager_transactions (id),
        constraint wallet_ledger_entries_wallet_currency_fk
          foreign key (wallet_id, currency) references wallets (id, currency),
        constraint wallet_ledger_entries_transaction_wallet_unique unique (transaction_id, wallet_id),
        constraint wallet_ledger_entries_wallet_version_unique unique (wallet_id, wallet_version),
        constraint wallet_ledger_entries_direction check (direction in ('DEBIT', 'CREDIT')),
        constraint wallet_ledger_entries_amount_positive check (amount > 0),
        constraint wallet_ledger_entries_currency_matches check (
          currency = balance_before_currency and currency = balance_after_currency
        ),
        constraint wallet_ledger_entries_arithmetic check (
          balance_before_amount >= 0
          and balance_after_amount >= 0
          and (
            (direction = 'CREDIT' and balance_after_amount = balance_before_amount + amount)
            or (direction = 'DEBIT' and balance_after_amount = balance_before_amount - amount)
          )
        ),
        constraint wallet_ledger_entries_version_positive check (wallet_version >= 1)
      );
    `);

    this.addSql(`
      create function wallet_ledger_entries_reject_change() returns trigger
      language plpgsql as $$
      begin
        raise exception 'wallet_ledger_entries_immutable: % on the ledger is not allowed', tg_op
          using errcode = 'integrity_constraint_violation';
      end;
      $$;
    `);
    this.addSql(`
      create trigger wallet_ledger_entries_immutable
        before update or delete on wallet_ledger_entries
        for each row execute function wallet_ledger_entries_reject_change();
    `);
    this.addSql(`
      create trigger wallet_ledger_entries_immutable_truncate
        before truncate on wallet_ledger_entries
        for each statement execute function wallet_ledger_entries_reject_change();
    `);

    this.addSql(`
      create function wallets_check_balance_ledger() returns trigger
      language plpgsql as $$
      declare
        old_balance numeric(19, 2);
        old_version integer;
      begin
        if tg_op = 'INSERT' then
          old_balance := 0;
          old_version := 0;
          if new.version <> 1 then
            raise exception 'wallets_balance_ledger_mismatch: wallet % must be born at version 1, got %',
              new.id, new.version
              using errcode = 'integrity_constraint_violation';
          end if;
        else
          old_balance := old.balance_amount;
          old_version := old.version;
        end if;

        if new.balance_amount = old_balance then
          if tg_op = 'UPDATE' and new.version <> old_version then
            raise exception 'wallets_balance_ledger_mismatch: wallet % changed version % -> % without a balance change',
              new.id, old_version, new.version
              using errcode = 'integrity_constraint_violation';
          end if;
          return null;
        end if;

        if new.version <> old_version + 1 then
          raise exception 'wallets_balance_ledger_mismatch: wallet % changed balance with version % -> %, expected %',
            new.id, old_version, new.version, old_version + 1
            using errcode = 'integrity_constraint_violation';
        end if;

        if not exists (
          select 1
            from wallet_ledger_entries
           where wallet_id = new.id
             and wallet_version = new.version
             and balance_before_amount = old_balance
             and balance_after_amount = new.balance_amount
        ) then
          raise exception 'wallets_balance_ledger_mismatch: wallet % changed balance % -> % at version % with no matching ledger entry',
            new.id, old_balance, new.balance_amount, new.version
            using errcode = 'integrity_constraint_violation';
        end if;
        return null;
      end;
      $$;
    `);
    this.addSql(`
      create constraint trigger wallets_balance_ledger
        after insert or update on wallets
        deferrable initially deferred
        for each row execute function wallets_check_balance_ledger();
    `);
  }

  override down(): void {
    this.addSql('drop trigger wallets_balance_ledger on wallets;');
    this.addSql('drop function wallets_check_balance_ledger();');
    this.addSql('drop table wallet_ledger_entries;');
    this.addSql('drop function wallet_ledger_entries_reject_change();');
  }
}
