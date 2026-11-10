/**
 * Makes the database guarantee `wager_transactions` (`ARCHITECTURE.md` §
 * Invariantes no schema):
 *
 * - idempotency key and external transaction id unique per provider;
 * - static coherence `CHECK`s for every kind and status: the reference by kind,
 *   the amount floor (`LOSS` may be zero), `PENDING` never persisted,
 *   `PENDING_REFERENCE` only for kinds that wait, and `processed_at`, the
 *   failure code and the observed balance present exactly in the statuses that
 *   have them;
 * - a terminal row (`PROCESSED`, `REJECTED`, `FAILED`) never changes, the
 *   identity columns never change in any status, and no row is ever deleted.
 *
 * @packageDocumentation
 */
import { Migration } from '@mikro-orm/migrations';

// Every column a transaction is identified by: fixed from its first insert.
const IDENTITY_COLUMNS = [
  'id',
  'provider_id',
  'external_transaction_id',
  'idempotency_key',
  'payload_hash',
  'wallet_id',
  'player_id',
  'round_id',
  'game_id',
  'kind',
  'amount',
  'currency',
  'reference_external_transaction_id',
  'correlation_id',
  'created_at',
];

const identityOf = (row: 'old' | 'new'): string => IDENTITY_COLUMNS.map((column) => `${row}.${column}`).join(', ');

export class Migration0005WagerTransactionInvariants extends Migration {
  override name = 'Migration0005WagerTransactionInvariants';

  override up(): void {
    this.addSql(`
      alter table wager_transactions
        drop constraint wager_transactions_amount_positive,
        add constraint wager_transactions_amount_positive check (
          amount > 0 or (kind = 'LOSS' and amount >= 0)
        ),
        add constraint wager_transactions_provider_idempotency_key_unique unique (provider_id, idempotency_key),
        add constraint wager_transactions_provider_external_id_unique unique (provider_id, external_transaction_id),
        add constraint wager_transactions_reference_by_kind check (
          kind = 'WIN'
          or (kind in ('OPENING', 'BET', 'LOSS') and reference_external_transaction_id is null)
          or (kind in ('REFUND', 'ROLLBACK') and reference_external_transaction_id is not null)
        ),
        add constraint wager_transactions_not_pending check (status <> 'PENDING'),
        add constraint wager_transactions_pending_reference_kind check (
          status <> 'PENDING_REFERENCE' or kind in ('WIN', 'REFUND', 'ROLLBACK')
        ),
        add constraint wager_transactions_processed_at check (
          (status = 'PROCESSED') = (processed_at is not null)
        ),
        add constraint wager_transactions_failure_code check (
          (status in ('REJECTED', 'FAILED')) = (failure_code is not null)
        ),
        add constraint wager_transactions_observed_balance check (
          case when status in ('PROCESSED', 'REJECTED')
            then balance_after_amount is not null
             and balance_after_currency is not null
             and wallet_version_observed is not null
            else balance_after_amount is null
             and balance_after_currency is null
             and wallet_version_observed is null
          end
        );
    `);

    this.addSql(`
      create function wager_transactions_guard_change() returns trigger
      language plpgsql as $$
      begin
        if tg_op in ('DELETE', 'TRUNCATE') then
          raise exception 'wager_transactions_immutable: % on wager transactions is not allowed', tg_op
            using errcode = 'integrity_constraint_violation';
        end if;
        if old.status <> 'PENDING_REFERENCE' then
          raise exception 'wager_transactions_terminal_immutable: transaction % is % and never changes',
            old.id, old.status
            using errcode = 'integrity_constraint_violation';
        end if;
        if (${identityOf('new')}) is distinct from (${identityOf('old')}) then
          raise exception 'wager_transactions_identity_immutable: the identity of transaction % never changes',
            old.id
            using errcode = 'integrity_constraint_violation';
        end if;
        return new;
      end;
      $$;
    `);
    this.addSql(`
      create trigger wager_transactions_guard
        before update or delete on wager_transactions
        for each row execute function wager_transactions_guard_change();
    `);
    this.addSql(`
      create trigger wager_transactions_guard_truncate
        before truncate on wager_transactions
        for each statement execute function wager_transactions_guard_change();
    `);
  }

  override down(): void {
    this.addSql('drop trigger wager_transactions_guard_truncate on wager_transactions;');
    this.addSql('drop trigger wager_transactions_guard on wager_transactions;');
    this.addSql('drop function wager_transactions_guard_change();');
    this.addSql(`
      alter table wager_transactions
        drop constraint wager_transactions_observed_balance,
        drop constraint wager_transactions_failure_code,
        drop constraint wager_transactions_processed_at,
        drop constraint wager_transactions_pending_reference_kind,
        drop constraint wager_transactions_not_pending,
        drop constraint wager_transactions_reference_by_kind,
        drop constraint wager_transactions_provider_external_id_unique,
        drop constraint wager_transactions_provider_idempotency_key_unique,
        drop constraint wager_transactions_amount_positive,
        -- Not validated: a zero LOSS written meanwhile must not block the rollback.
        add constraint wager_transactions_amount_positive check (amount > 0) not valid;
    `);
  }
}
