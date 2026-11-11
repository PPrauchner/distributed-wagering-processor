/**
 * Schedules the transactions pending their reference (`ARCHITECTURE.md` §
 * Referências fora de ordem): `attempts` counts the worker's attempts and
 * `next_attempt_at` says when the next one is due — also the lease of a
 * claimed one. A pending reference always has its next attempt; the ones
 * already pending are due at once. A partial index on `next_attempt_at` serves
 * the worker's claim, which only reads `PENDING_REFERENCE` rows. The
 * immutability trigger is untouched: it already accepts any change of a
 * pending row but its identity.
 *
 * @packageDocumentation
 */
import { Migration } from '@mikro-orm/migrations';

export class Migration0011WagerTransactionReferenceSchedule extends Migration {
  override name = 'Migration0011WagerTransactionReferenceSchedule';

  override up(): void {
    this.addSql(`
      alter table wager_transactions
        add column attempts integer not null default 0,
        add column next_attempt_at timestamptz;
    `);
    this.addSql(`update wager_transactions set next_attempt_at = now() where status = 'PENDING_REFERENCE';`);
    this.addSql(`
      alter table wager_transactions
        add constraint wager_transactions_attempts_non_negative check (attempts >= 0),
        add constraint wager_transactions_pending_reference_schedule check (
          status <> 'PENDING_REFERENCE' or next_attempt_at is not null
        );
    `);
    this.addSql(`
      create index wager_transactions_pending_reference_next_attempt_idx
        on wager_transactions (next_attempt_at) where status = 'PENDING_REFERENCE';
    `);
  }

  override down(): void {
    this.addSql('drop index wager_transactions_pending_reference_next_attempt_idx;');
    this.addSql(`
      alter table wager_transactions
        drop constraint wager_transactions_pending_reference_schedule,
        drop constraint wager_transactions_attempts_non_negative,
        drop column next_attempt_at,
        drop column attempts;
    `);
  }
}
