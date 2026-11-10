/**
 * `FaultInjector` bound to one SQL transaction. Each enabled point provokes a
 * real failure; with no point enabled — the default — it never touches the
 * database.
 *
 * @packageDocumentation
 */
import type { EntityManager } from '@mikro-orm/postgresql';
import { FaultPoint, type FaultContext, type FaultInjector } from '../shared/application/fault-injector.ts';

export class SqlFaultInjector implements FaultInjector {
  constructor(
    private readonly em: EntityManager,
    private readonly enabled: ReadonlySet<FaultPoint>,
  ) {}

  async inject(point: FaultPoint, context: FaultContext): Promise<void> {
    if (!this.enabled.has(point)) return;
    if (point === FaultPoint.InvariantViolationBeforeCommit) await this.violateInvariant(context);
    // The crash points belong to the queue consumer and the outbox publisher.
  }

  /**
   * Writes what the unit of work holds, then changes the transaction just
   * written: a terminal row, which the immutability trigger refuses.
   */
  private async violateInvariant({ transactionId }: FaultContext): Promise<void> {
    if (transactionId === undefined) throw new Error(`${FaultPoint.InvariantViolationBeforeCommit} needs a transaction id`);
    await this.em.flush();
    await this.em.execute('update wager_transactions set status = status where id = ?', [transactionId]);
  }
}
