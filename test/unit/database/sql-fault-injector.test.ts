/**
 * Unit tests for the SQL fault injector: with no fault point enabled — the
 * default, when `FAULT_INJECTION` is not set — it is a no-op that never touches
 * the database.
 *
 * @packageDocumentation
 */
import { describe, expect, test } from 'bun:test';
import type { EntityManager } from '@mikro-orm/postgresql';
import { SqlFaultInjector } from '../../../src/database/sql-fault-injector.ts';
import { FaultPoint, SimulatedCrashError } from '../../../src/shared/application/fault-injector.ts';

/** An entity manager that fails the test if the injector uses it at all. */
const untouchable = new Proxy({} as EntityManager, {
  get: (_target, property) => {
    throw new Error(`the entity manager was used: ${String(property)}`);
  },
});

describe('SqlFaultInjector', () => {
  test.each(Object.values(FaultPoint))('is a no-op at %s when no point is enabled', async (point) => {
    const faults = new SqlFaultInjector(untouchable, new Set());

    await expect(faults.inject(point, { transactionId: 'any' })).resolves.toBeUndefined();
  });

  test('a point not enabled stays silent while another is enabled', async () => {
    const faults = new SqlFaultInjector(untouchable, new Set([FaultPoint.CrashAfterSend]));

    await expect(
      faults.inject(FaultPoint.InvariantViolationBeforeCommit, { transactionId: 'any' }),
    ).resolves.toBeUndefined();
  });
});

describe('crash-after-send', () => {
  test('when enabled, the publisher dies there: a simulated crash, without touching the database', async () => {
    const faults = new SqlFaultInjector(untouchable, new Set([FaultPoint.CrashAfterSend]));

    await expect(faults.inject(FaultPoint.CrashAfterSend, {})).rejects.toBeInstanceOf(SimulatedCrashError);
  });
});
