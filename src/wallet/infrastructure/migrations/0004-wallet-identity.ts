/**
 * Makes a wallet's identity immutable: `id`, `player_id` and `currency` never
 * change. Migration 0012 extends this trigger to the creation columns.
 *
 * @packageDocumentation
 */
import { Migration } from '@mikro-orm/migrations';

export class Migration0004WalletIdentity extends Migration {
  override name = 'Migration0004WalletIdentity';

  override up(): void {
    this.addSql(`
      create function wallets_reject_identity_change() returns trigger
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
      create trigger wallets_identity_immutable
        before update on wallets
        for each row execute function wallets_reject_identity_change();
    `);
  }

  override down(): void {
    this.addSql('drop trigger wallets_identity_immutable on wallets;');
    this.addSql('drop function wallets_reject_identity_change();');
  }
}
