/**
 * Idempotent wallet creation: the creation key and payload hash (both absent or
 * both present, the key unique) and the initial balance, which the replay
 * returns. Existing wallets get their initial balance from the opening entry,
 * or zero when they have none. The identity trigger of 0004 is extended to the
 * new columns: none of them ever changes.
 *
 * @packageDocumentation
 */
import { Migration } from '@mikro-orm/migrations';

export class Migration0012WalletCreationIdempotency extends Migration {
  override name = 'Migration0012WalletCreationIdempotency';

  override up(): void {
    this.addSql(`
      alter table wallets
        add column creation_idempotency_key varchar(255),
        add column creation_payload_hash char(64),
        add column initial_balance_amount numeric(19, 2),
        add column initial_balance_currency char(3);
    `);
    this.addSql(`
      update wallets w
         set initial_balance_amount = coalesce(
               (select e.amount from wallet_ledger_entries e
                 where e.wallet_id = w.id and e.wallet_version = 1),
               0),
             initial_balance_currency = w.currency;
    `);
    this.addSql(`
      alter table wallets
        alter column initial_balance_amount set not null,
        alter column initial_balance_currency set not null,
        add constraint wallets_creation_idempotency_key_unique unique (creation_idempotency_key),
        add constraint wallets_creation_key_and_hash_together
          check ((creation_idempotency_key is null) = (creation_payload_hash is null)),
        add constraint wallets_initial_balance_non_negative check (initial_balance_amount >= 0),
        add constraint wallets_initial_balance_currency_matches check (currency = initial_balance_currency);
    `);
    this.addSql(`
      create or replace function wallets_reject_identity_change() returns trigger
      language plpgsql as $$
      begin
        if new.id <> old.id or new.player_id <> old.player_id or new.currency <> old.currency
           or new.initial_balance_amount <> old.initial_balance_amount
           or new.initial_balance_currency <> old.initial_balance_currency
           or new.creation_idempotency_key is distinct from old.creation_idempotency_key
           or new.creation_payload_hash is distinct from old.creation_payload_hash then
          raise exception 'wallets_identity_immutable: the identity and creation of wallet % never change', old.id
            using errcode = 'integrity_constraint_violation';
        end if;
        return new;
      end;
      $$;
    `);
  }

  override down(): void {
    this.addSql(`
      create or replace function wallets_reject_identity_change() returns trigger
      language plpgsql as $$
      begin
        if new.id <> old.id or new.player_id <> old.player_id or new.currency <> old.currency then
          raise exception 'wallets_identity_immutable: the id, player and currency of wallet % never change', old.id
            using errcode = 'integrity_constraint_violation';
        end if;
        return new;
      end;
      $$;
    `);
    this.addSql(`
      alter table wallets
        drop column creation_idempotency_key,
        drop column creation_payload_hash,
        drop column initial_balance_amount,
        drop column initial_balance_currency;
    `);
  }
}
