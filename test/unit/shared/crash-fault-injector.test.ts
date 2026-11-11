/**
 * Unit tests for the crash fault injector: a no-op by default, a simulated
 * crash at an enabled crash point, and never a fault that needs a database.
 *
 * @packageDocumentation
 */
import { describe, expect, test } from 'bun:test';
import { FaultPoint, SimulatedCrashError } from '../../../src/shared/application/fault-injector.ts';
import { CrashFaultInjector } from '../../../src/shared/infrastructure/crash-fault-injector.ts';

describe('CrashFaultInjector', () => {
  test.each(Object.values(FaultPoint))('is a no-op at %s when no point is enabled', async (point) => {
    await expect(new CrashFaultInjector([]).inject(point, {})).resolves.toBeUndefined();
  });

  test('crash-after-commit, when enabled, is a simulated crash', async () => {
    const faults = new CrashFaultInjector([FaultPoint.CrashAfterCommit]);

    await expect(faults.inject(FaultPoint.CrashAfterCommit, {})).rejects.toBeInstanceOf(SimulatedCrashError);
  });

  test('a fault that needs a unit of work is never fired here', async () => {
    const faults = new CrashFaultInjector([FaultPoint.InvariantViolationBeforeCommit]);

    await expect(faults.inject(FaultPoint.InvariantViolationBeforeCommit, {})).resolves.toBeUndefined();
  });
});
