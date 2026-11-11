/**
 * Creates `inbox_messages`, the queue messages each consumer already received
 * (`ARCHITECTURE.md` § Mensageria). The primary key `(consumer_name,
 * message_id)` is named `inbox_messages_pkey` on purpose: the database error
 * classifier knows a redelivery by that name. Rows are written in the SQL
 * transaction of the outcome they led to, and never changed afterwards.
 *
 * @packageDocumentation
 */
import { Migration } from '@mikro-orm/migrations';

export class Migration0010InboxMessages extends Migration {
  override name = 'Migration0010InboxMessages';

  override up(): void {
    this.addSql(`
      create table inbox_messages (
        consumer_name text not null,
        message_id text not null,
        payload_hash char(64) not null,
        received_at timestamptz not null,
        processed_at timestamptz,
        constraint inbox_messages_pkey primary key (consumer_name, message_id),
        constraint inbox_messages_consumer_name_not_empty check (consumer_name <> ''),
        constraint inbox_messages_message_id_not_empty check (message_id <> '')
      );
    `);
  }

  override down(): void {
    this.addSql('drop table inbox_messages;');
  }
}
