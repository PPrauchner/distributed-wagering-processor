/**
 * Readiness probe of PostgreSQL: `SELECT 1` on a connection of the pool.
 *
 * @packageDocumentation
 */
import type { EntityManager } from '@mikro-orm/postgresql';
import type { ReadinessProbe } from '../application/check-readiness.ts';

export class DatabaseReadiness implements ReadinessProbe {
  readonly name = 'database';

  constructor(private readonly em: EntityManager) {}

  async check(): Promise<void> {
    await this.em.fork().execute('select 1');
  }
}
