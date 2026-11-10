/**
 * Migration do spike: tabela de carteiras com o saldo não negativo garantido por
 * CHECK no schema.
 *
 * @packageDocumentation
 */
import { Migration } from '@mikro-orm/migrations';

export class Migration0001SpikeWallets extends Migration {
  override name = 'Migration0001SpikeWallets';

  override up(): void {
    this.addSql(`
      create table spike_wallets (
        id uuid primary key,
        balance numeric(19, 2) not null,
        version integer not null,
        constraint spike_wallets_balance_non_negative check (balance >= 0)
      );
    `);
  }

  override down(): void {
    this.addSql('drop table spike_wallets;');
  }
}
