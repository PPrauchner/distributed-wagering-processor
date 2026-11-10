/**
 * Unit tests for the service configuration read from the environment.
 *
 * @packageDocumentation
 */
import { describe, expect, test } from 'bun:test';
import { loadConfig } from '../../src/config.ts';

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
