/**
 * Creates the `wager_transactions` table with the final columns of the
 * `WagerTransaction` model, as far as the opening needs them: the wallet
 * foreign key, a positive amount and the known kinds and statuses. Uniqueness,
 * per-kind and per-status coherence and the terminal-row trigger come with the
 * `BET`; the pending-reference columns and the reference foreign key with their
 * own slices.
 *
 * @packageDocumentation
 */
import { Migration } from '@mikro-orm/migrations';

export class Migration0002WagerTransactions extends Migration {
  override name = 'Migration0002WagerTransactions';

  override up(): void {
    this.addSql(`
      create table wager_transactions (
        id uuid primary key,
        provider_id varchar(255) not null,
        external_transaction_id varchar(255) not null,
        idempotency_key varchar(255) not null,
        payload_hash char(64) not null,
        wallet_id uuid not null,
        player_id varchar(255) not null,
        round_id varchar(255) not null,
        game_id varchar(255) not null,
        kind text not null,
        amount numeric(19, 2) not null,
        currency char(3) not null,
        reference_external_transaction_id varchar(255),
        reference_transaction_id uuid,
        status text not null,
        failure_code text,
        processed_at timestamptz,
        balance_after_amount numeric(19, 2),
        balance_after_currency char(3),
        wallet_version_observed integer,
        correlation_id text not null,
        created_at timestamptz not null,
        constraint wager_transactions_wallet_fk foreign key (wallet_id) references wallets (id),
        constraint wager_transactions_amount_positive check (amount > 0),
        constraint wager_transactions_kind check (
          kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')
        ),
        constraint wager_transactions_status check (
          status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')
        )
      );
    `);
  }

  override down(): void {
    this.addSql('drop table wager_transactions;');
  }
}
