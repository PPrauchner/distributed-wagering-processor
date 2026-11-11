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

describe('the outbox publisher', () => {
  test('defaults: enabled, polling every 500 ms, 30 s lease, backoff from 1 s up to 5 min, wagering-events.fifo', () => {
    const config = loadConfig({});

    expect(config.outboxPublisher).toEqual({
      enabled: true,
      pollIntervalMs: 500,
      leaseMs: 30_000,
      retryBaseMs: 1000,
      retryMaxMs: 300_000,
    });
    expect(config.sqs).toEqual({
      endpoint: 'http://127.0.0.1:4566',
      region: 'us-east-1',
      accessKeyId: 'test',
      secretAccessKey: 'test',
      wagerTransactionsQueue: 'wager-transactions.fifo',
      wageringEventsQueue: 'wagering-events.fifo',
    });
  });

  test('the times, the queue and the endpoint come from the environment', () => {
    const config = loadConfig({
      OUTBOX_PUBLISHER_ENABLED: 'false',
      OUTBOX_POLL_INTERVAL_MS: '50',
      OUTBOX_LEASE_MS: '1000',
      OUTBOX_RETRY_BASE_MS: '10',
      OUTBOX_RETRY_MAX_MS: '100',
      SQS_ENDPOINT: 'http://localstack:4566',
      AWS_REGION: 'sa-east-1',
      WAGER_TRANSACTIONS_QUEUE: 'wager-transactions-abc.fifo',
      WAGERING_EVENTS_QUEUE: 'wagering-events-abc.fifo',
    });

    expect(config.outboxPublisher).toEqual({
      enabled: false,
      pollIntervalMs: 50,
      leaseMs: 1000,
      retryBaseMs: 10,
      retryMaxMs: 100,
    });
    expect(config.sqs).toMatchObject({
      endpoint: 'http://localstack:4566',
      region: 'sa-east-1',
      wagerTransactionsQueue: 'wager-transactions-abc.fifo',
      wageringEventsQueue: 'wagering-events-abc.fifo',
    });
  });

  test.each(['OUTBOX_POLL_INTERVAL_MS', 'OUTBOX_LEASE_MS', 'OUTBOX_RETRY_BASE_MS', 'OUTBOX_RETRY_MAX_MS'])(
    '%s must be a positive integer',
    (name) => {
      expect(() => loadConfig({ [name]: '0' })).toThrow(name);
      expect(() => loadConfig({ [name]: 'soon' })).toThrow(name);
    },
  );

  test('OUTBOX_PUBLISHER_ENABLED takes only true or false', () => {
    expect(() => loadConfig({ OUTBOX_PUBLISHER_ENABLED: 'maybe' })).toThrow(/OUTBOX_PUBLISHER_ENABLED/);
  });
});
