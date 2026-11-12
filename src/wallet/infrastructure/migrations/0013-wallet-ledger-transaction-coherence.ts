/**
 * Ties every ledger entry to the transaction it applies (`ARCHITECTURE.md` §
 * Invariantes no schema):
 *
 * - a composite foreign key `(transaction_id, wallet_id, amount, currency)`
 *   pins the entry to the wallet, amount and currency of its transaction. Its
 *   target, a `UNIQUE (id, wallet_id, amount, currency)` on
 *   `wager_transactions`, is redundant with the primary key and exists only for
 *   the foreign key. It can be immediate: those columns never change;
 * - a deferred constraint trigger requires, at commit, the entry's transaction
 *   `PROCESSED` and not a `LOSS`, and the entry's direction the one its kind
 *   decides — a `ROLLBACK` the inverse of the entry it undoes, which must
 *   exist. Deferred because the pending-references worker may update the
 *   transaction to `PROCESSED` after inserting its entry;
 * - a deferred constraint trigger requires, at commit, the wallet at least at
 *   the entry's version and its latest entry ending at its balance: no entry
 *   without the balance change it records — the converse of the
 *   `wallets_balance_ledger` trigger of 0003.
 *
 * @packageDocumentation
 */
import { Migration } from '@mikro-orm/migrations';

export class Migration0013WalletLedgerTransactionCoherence extends Migration {
  override name = 'Migration0013WalletLedgerTransactionCoherence';

  override up(): void {
    this.addSql(`
      alter table wager_transactions
        add constraint wager_transactions_ledger_terms_unique unique (id, wallet_id, amount, currency);
    `);
    this.addSql(`
      alter table wallet_ledger_entries
        add constraint wallet_ledger_entries_transaction_terms_fk
          foreign key (transaction_id, wallet_id, amount, currency)
          references wager_transactions (id, wallet_id, amount, currency);
    `);

    this.addSql(`
      create function wallet_ledger_entries_check_transaction() returns trigger
      language plpgsql as $$
      declare
        applied wager_transactions%rowtype;
        undone_direction text;
        expected text;
      begin
        select * into applied from wager_transactions where id = new.transaction_id;

        if applied.status <> 'PROCESSED' then
          raise exception 'wallet_ledger_entries_transaction_coherence: entry % is for transaction %, which is %',
            new.id, applied.id, applied.status
            using errcode = 'integrity_constraint_violation';
        end if;

        case applied.kind
          when 'BET' then
            expected := 'DEBIT';
          when 'OPENING', 'WIN', 'REFUND' then
            expected := 'CREDIT';
          when 'ROLLBACK' then
            select direction into undone_direction
              from wallet_ledger_entries
             where transaction_id = applied.reference_transaction_id
               and wallet_id = new.wallet_id;
            if undone_direction is null then
              raise exception 'wallet_ledger_entries_transaction_coherence: ROLLBACK % references %, which has no entry in wallet %',
                applied.id, applied.reference_transaction_id, new.wallet_id
                using errcode = 'integrity_constraint_violation';
            end if;
            expected := case undone_direction when 'DEBIT' then 'CREDIT' else 'DEBIT' end;
          else
            raise exception 'wallet_ledger_entries_transaction_coherence: entry % is for transaction %, a % that moves no balance',
              new.id, applied.id, applied.kind
              using errcode = 'integrity_constraint_violation';
        end case;

        if new.direction <> expected then
          raise exception 'wallet_ledger_entries_transaction_coherence: entry % writes % % as a %, expected %',
            new.id, applied.kind, applied.id, new.direction, expected
            using errcode = 'integrity_constraint_violation';
        end if;
        return null;
      end;
      $$;
    `);
    this.addSql(`
      create constraint trigger wallet_ledger_entries_transaction_coherence
        after insert on wallet_ledger_entries
        deferrable initially deferred
        for each row execute function wallet_ledger_entries_check_transaction();
    `);

    this.addSql(`
      create function wallet_ledger_entries_check_balance_applied() returns trigger
      language plpgsql as $$
      declare
        current_balance numeric(19, 2);
        current_version integer;
        latest_balance numeric(19, 2);
      begin
        select balance_amount, version into current_balance, current_version
          from wallets where id = new.wallet_id;
        select balance_after_amount into latest_balance
          from wallet_ledger_entries
         where wallet_id = new.wallet_id
         order by wallet_version desc
         limit 1;

        if current_version < new.wallet_version or latest_balance <> current_balance then
          raise exception 'wallet_ledger_entries_balance_applied: entry % at version % leaves wallet % at balance % and version %, not applied',
            new.id, new.wallet_version, new.wallet_id, current_balance, current_version
            using errcode = 'integrity_constraint_violation';
        end if;
        return null;
      end;
      $$;
    `);
    this.addSql(`
      create constraint trigger wallet_ledger_entries_balance_applied
        after insert on wallet_ledger_entries
        deferrable initially deferred
        for each row execute function wallet_ledger_entries_check_balance_applied();
    `);
  }

  override down(): void {
    this.addSql('drop trigger wallet_ledger_entries_balance_applied on wallet_ledger_entries;');
    this.addSql('drop function wallet_ledger_entries_check_balance_applied();');
    this.addSql('drop trigger wallet_ledger_entries_transaction_coherence on wallet_ledger_entries;');
    this.addSql('drop function wallet_ledger_entries_check_transaction();');
    this.addSql('alter table wallet_ledger_entries drop constraint wallet_ledger_entries_transaction_terms_fk;');
    this.addSql('alter table wager_transactions drop constraint wager_transactions_ledger_terms_unique;');
  }
}
