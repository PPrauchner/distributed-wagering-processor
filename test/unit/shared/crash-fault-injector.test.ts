/**
 * Unit tests for the crash fault injector: a no-op by default, a simulated
 * crash at an enabled crash point — or the crash the composition root gave
 * it —, and never a fault that needs a database.
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

  test('with a crash of its own — the process one —, an enabled point calls it and nothing else', async () => {
    const crashed: FaultPoint[] = [];
    const faults = new CrashFaultInjector([FaultPoint.CrashAfterCommit], (point) => {
      crashed.push(point);
      throw new Error('the process would be gone here');
    });

    await expect(faults.inject(FaultPoint.CrashAfterCommit, {})).rejects.toThrow('the process would be gone here');
    expect(crashed).toEqual([FaultPoint.CrashAfterCommit]);
  });

  test('a crash of its own is never called at a point not enabled', async () => {
    let crashed = false;
    const faults = new CrashFaultInjector([], () => {
      crashed = true;
      throw new Error('unreachable');
    });

    await faults.inject(FaultPoint.CrashAfterCommit, {});
    expect(crashed).toBe(false);
  });

  test('a fault that needs a unit of work is never fired here', async () => {
    const faults = new CrashFaultInjector([FaultPoint.InvariantViolationBeforeCommit]);

    await expect(faults.inject(FaultPoint.InvariantViolationBeforeCommit, {})).resolves.toBeUndefined();
  });
});
