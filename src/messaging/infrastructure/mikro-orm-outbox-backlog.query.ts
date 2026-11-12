/**
 * `OutboxBacklogQuery` over a MikroORM entity manager: one aggregate over the
 * unpublished messages, served by the partial index on `published_at is null`;
 * the stuck ones are counted in the same pass.
 *
 * @packageDocumentation
 */
import type { EntityManager } from '@mikro-orm/postgresql';
import type { OutboxBacklog, OutboxBacklogQuery } from '../application/outbox-backlog.ts';
import { STUCK_ATTEMPTS } from '../domain/outbox-message.ts';

export class MikroOrmOutboxBacklogQuery implements OutboxBacklogQuery {
  constructor(private readonly em: EntityManager) {}

  async read(): Promise<OutboxBacklog> {
    const [row] = await this.em.execute<{ pending: number; lag_seconds: number; stuck: number }[]>(
      `select count(*)::int as pending,
              coalesce(extract(epoch from now() - min(occurred_at)), 0)::float8 as lag_seconds,
              count(*) filter (where attempts >= ?)::int as stuck
         from outbox_messages
        where published_at is null`,
      [STUCK_ATTEMPTS],
    );
    return {
      pending: Number(row?.pending ?? 0),
      lagSeconds: Number(row?.lag_seconds ?? 0),
      stuck: Number(row?.stuck ?? 0),
    };
  }
}
