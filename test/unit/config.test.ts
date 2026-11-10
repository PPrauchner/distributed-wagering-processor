/**
 * Unit tests for the service configuration read from the environment.
 *
 * @packageDocumentation
 */
import { describe, expect, test } from 'bun:test';
import { loadConfig } from '../../src/config.ts';
import { FaultPoint } from '../../src/shared/application/fault-injector.ts';

describe('loadConfig', () => {
  test('the Retry-After of a 503 is 1 s by default', () => {
    expect(loadConfig({}).retryAfterSeconds).toBe(1);
  });

  test('RETRY_AFTER_SECONDS overrides it', () => {
    expect(loadConfig({ RETRY_AFTER_SECONDS: '5' }).retryAfterSeconds).toBe(5);
  });

  test.each(['0', '-1', '1.5', 'soon'])('RETRY_AFTER_SECONDS=%s is refused', (value) => {
    expect(() => loadConfig({ RETRY_AFTER_SECONDS: value })).toThrow(/RETRY_AFTER_SECONDS/);
  });
});

describe('fault injection', () => {
  test('no fault point is enabled without FAULT_INJECTION', () => {
    expect(loadConfig({}).faultPoints).toEqual([]);
    expect(loadConfig({ FAULT_INJECTION: '' }).faultPoints).toEqual([]);
  });

  test('FAULT_INJECTION enables the named points', () => {
    expect(
      loadConfig({ FAULT_INJECTION: 'invariant-violation-before-commit, crash-after-commit' }).faultPoints,
    ).toEqual([FaultPoint.InvariantViolationBeforeCommit, FaultPoint.CrashAfterCommit]);
  });

  test('an unknown point is refused', () => {
    expect(() => loadConfig({ FAULT_INJECTION: 'crash-everywhere' })).toThrow(/unknown fault point/);
  });

  test('it is refused in production', () => {
    expect(() =>
      loadConfig({ FAULT_INJECTION: 'invariant-violation-before-commit', NODE_ENV: 'production' }),
    ).toThrow(/production/);
  });
});
