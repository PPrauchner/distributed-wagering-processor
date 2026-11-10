/**
 * Creates the `wallets` table. The wallet invariants live in the schema, not
 * only in code: non-negative balance, version from 1, wallet currency equal to
 * the balance currency, one wallet per player and currency, and `(id, currency)`
 * unique as the target of the ledger's currency foreign key.
 *
 * @packageDocumentation
 */
import { Migration } from '@mikro-orm/migrations';

export class Migration0001Wallets extends Migration {
  override name = 'Migration0001Wallets';

  override up(): void {
    this.addSql(`
      create table wallets (
        id uuid primary key,
        player_id varchar(255) not null,
        currency char(3) not null,
        balance_amount numeric(19, 2) not null,
        balance_currency char(3) not null,
        version integer not null,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        constraint wallets_currency_format check (currency ~ '^[A-Z]{3}$'),
        constraint wallets_balance_non_negative check (balance_amount >= 0),
        constraint wallets_version_positive check (version >= 1),
        constraint wallets_balance_currency_matches check (currency = balance_currency),
        constraint wallets_player_currency_unique unique (player_id, currency),
        constraint wallets_id_currency_unique unique (id, currency)
      );
    `);
  }

  override down(): void {
    this.addSql('drop table wallets;');
  }
}
