/**
 * Creates `rejected_submissions`, the audit of the submissions that never
 * became a wager transaction (`ARCHITECTURE.md` § Submissões não admitidas):
 * append-only — `UPDATE`, `DELETE` and `TRUNCATE` are refused —, with no
 * foreign key and no uniqueness, since every attempt is a row and a refused
 * payload may name nothing that exists. Only the failure code, the channel and
 * the reception time are required; the rest is what could be extracted.
 *
 * @packageDocumentation
 */
import { Migration } from '@mikro-orm/migrations';

export class Migration0006RejectedSubmissions extends Migration {
  override name = 'Migration0006RejectedSubmissions';

  override up(): void {
    this.addSql(`
      create table rejected_submissions (
        id uuid primary key,
        provider_id text,
        idempotency_key text,
        external_transaction_id text,
        payload_hash text,
        failure_code text not null,
        channel text not null,
        message_id text,
        correlation_id text,
        received_at timestamptz not null,
        constraint rejected_submissions_channel check (channel in ('HTTP', 'QUEUE'))
      );
    `);
    this.addSql(`
      create function rejected_submissions_reject_change() returns trigger
      language plpgsql as $$
      begin
        raise exception 'rejected_submissions_append_only: % on rejected submissions is not allowed', tg_op
          using errcode = 'integrity_constraint_violation';
      end;
      $$;
    `);
    this.addSql(`
      create trigger rejected_submissions_append_only
        before update or delete on rejected_submissions
        for each row execute function rejected_submissions_reject_change();
    `);
    this.addSql(`
      create trigger rejected_submissions_append_only_truncate
        before truncate on rejected_submissions
        for each statement execute function rejected_submissions_reject_change();
    `);
  }

  override down(): void {
    this.addSql('drop table rejected_submissions;');
    this.addSql('drop function rejected_submissions_reject_change();');
  }
}
