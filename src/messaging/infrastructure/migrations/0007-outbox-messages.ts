/**
 * Creates `outbox_messages`, the integration events waiting to be published
 * (`ARCHITECTURE.md` § Mensageria). `wallet_id` is required — it is the
 * `MessageGroupId` —, and a partial index on `next_attempt_at` serves the
 * publisher's claim, which only reads the unpublished messages. No foreign key:
 * the outbox records what happened, and an event never needs its wallet row.
 *
 * @packageDocumentation
 */
import { Migration } from '@mikro-orm/migrations';

export class Migration0007OutboxMessages extends Migration {
  override name = 'Migration0007OutboxMessages';

  override up(): void {
    this.addSql(`
      create table outbox_messages (
        id uuid primary key,
        aggregate_id text not null,
        event_type text not null,
        wallet_id uuid not null,
        payload jsonb not null,
        occurred_at timestamptz not null,
        attempts integer not null default 0,
        next_attempt_at timestamptz,
        published_at timestamptz,
        constraint outbox_messages_attempts_non_negative check (attempts >= 0)
      );
    `);
    this.addSql(`
      create index outbox_messages_pending_next_attempt_idx
        on outbox_messages (next_attempt_at) where published_at is null;
    `);
  }

  override down(): void {
    this.addSql('drop table outbox_messages;');
  }
}
