/**
 * `FaultInjector` bound to one SQL transaction. Each enabled point provokes a
 * real failure; with no point enabled — the default — it never touches the
 * database.
 *
 * @packageDocumentation
 */
import type { EntityManager } from '@mikro-orm/postgresql';
import {
  FaultPoint,
  SimulatedCrashError,
  type FaultContext,
  type FaultInjector,
} from '../shared/application/fault-injector.ts';

export class SqlFaultInjector implements FaultInjector {
  constructor(
    private readonly em: EntityManager,
    private readonly enabled: ReadonlySet<FaultPoint>,
  ) {}

  async inject(point: FaultPoint, context: FaultContext): Promise<void> {
    if (!this.enabled.has(point)) return;
    if (point === FaultPoint.InvariantViolationBeforeCommit) await this.violateInvariant(context);
    if (point === FaultPoint.TransientFailureInResolution) await this.refuseLock();
    // The process dies there: whatever the caller would do next never happens,
    // and the SQL transaction it runs in rolls back.
    if (point === FaultPoint.CrashAfterSend) throw new SimulatedCrashError(point);
    // `crash-after-commit` belongs to the queue consumer.
  }

  /** The error PostgreSQL raises when `lock_timeout` expires. */
  private async refuseLock(): Promise<void> {
    await this.em.execute(
      `do $$ begin raise exception 'simulated lock timeout' using errcode = 'lock_not_available'; end $$`,
    );
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
