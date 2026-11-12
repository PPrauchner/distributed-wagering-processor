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
      wagerTransactionsDlq: 'wager-transactions-dlq.fifo',
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
      WAGER_TRANSACTIONS_DLQ: 'wager-transactions-dlq-abc.fifo',
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
      wagerTransactionsDlq: 'wager-transactions-dlq-abc.fifo',
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

describe('the wager transactions consumer', () => {
  test('defaults: enabled, 20 s long polling, batches of 10, 30 s visibility, 5 receives, backoff up to 60 s, 20 s drain', () => {
    expect(loadConfig({}).wagerTransactionsConsumer).toEqual({
      enabled: true,
      waitTimeSeconds: 20,
      batchSize: 10,
      visibilityTimeoutSeconds: 30,
      maxReceives: 5,
      retryMaxSeconds: 60,
      drainTimeoutMs: 20_000,
    });
  });

  test('every setting comes from the environment', () => {
    const config = loadConfig({
      WAGER_TRANSACTIONS_CONSUMER_ENABLED: 'false',
      WAGER_TRANSACTIONS_WAIT_SECONDS: '0',
      WAGER_TRANSACTIONS_BATCH_SIZE: '3',
      WAGER_TRANSACTIONS_VISIBILITY_SECONDS: '5',
      WAGER_TRANSACTIONS_MAX_RECEIVES: '3',
      WAGER_TRANSACTIONS_RETRY_MAX_SECONDS: '1',
      WAGER_TRANSACTIONS_DRAIN_TIMEOUT_MS: '500',
    });

    expect(config.wagerTransactionsConsumer).toEqual({
      enabled: false,
      waitTimeSeconds: 0,
      batchSize: 3,
      visibilityTimeoutSeconds: 5,
      maxReceives: 3,
      retryMaxSeconds: 1,
      drainTimeoutMs: 500,
    });
  });

  test.each([
    ['WAGER_TRANSACTIONS_WAIT_SECONDS', '21'],
    ['WAGER_TRANSACTIONS_WAIT_SECONDS', '-1'],
    ['WAGER_TRANSACTIONS_BATCH_SIZE', '0'],
    ['WAGER_TRANSACTIONS_BATCH_SIZE', '11'],
    ['WAGER_TRANSACTIONS_VISIBILITY_SECONDS', '0'],
    ['WAGER_TRANSACTIONS_VISIBILITY_SECONDS', '1.5'],
    ['WAGER_TRANSACTIONS_CONSUMER_ENABLED', 'yes'],
    ['WAGER_TRANSACTIONS_MAX_RECEIVES', '0'],
    ['WAGER_TRANSACTIONS_RETRY_MAX_SECONDS', '0'],
    ['WAGER_TRANSACTIONS_DRAIN_TIMEOUT_MS', '0'],
  ])('%s=%s is refused', (name, value) => {
    expect(() => loadConfig({ [name]: value })).toThrow(new RegExp(name));
  });
});

describe('the pending references worker', () => {
  test('defaults: enabled, 5 min TTL, polling every 1 s, 30 s lease, backoff from 1 s up to 60 s', () => {
    expect(loadConfig({}).pendingReferences).toEqual({
      enabled: true,
      ttlMs: 300_000,
      pollIntervalMs: 1000,
      leaseMs: 30_000,
      retryBaseMs: 1000,
      retryMaxMs: 60_000,
    });
  });

  test('every setting comes from the environment', () => {
    const config = loadConfig({
      PENDING_REFERENCES_WORKER_ENABLED: 'false',
      PENDING_REFERENCE_TTL_MS: '2000',
      PENDING_REFERENCES_POLL_INTERVAL_MS: '50',
      PENDING_REFERENCES_LEASE_MS: '1000',
      PENDING_REFERENCES_RETRY_BASE_MS: '10',
      PENDING_REFERENCES_RETRY_MAX_MS: '100',
    });

    expect(config.pendingReferences).toEqual({
      enabled: false,
      ttlMs: 2000,
      pollIntervalMs: 50,
      leaseMs: 1000,
      retryBaseMs: 10,
      retryMaxMs: 100,
    });
  });

  test.each([
    'PENDING_REFERENCE_TTL_MS',
    'PENDING_REFERENCES_POLL_INTERVAL_MS',
    'PENDING_REFERENCES_LEASE_MS',
    'PENDING_REFERENCES_RETRY_BASE_MS',
    'PENDING_REFERENCES_RETRY_MAX_MS',
  ])('%s must be a positive integer', (name) => {
    expect(() => loadConfig({ [name]: '0' })).toThrow(name);
  });

  test('PENDING_REFERENCES_WORKER_ENABLED takes only true or false', () => {
    expect(() => loadConfig({ PENDING_REFERENCES_WORKER_ENABLED: 'maybe' })).toThrow(/PENDING_REFERENCES_WORKER_ENABLED/);
  });
});

describe('log level', () => {
  test('is info by default', () => {
    expect(loadConfig({}).logLevel).toBe('info');
  });

  test.each(['silent', 'debug', 'warn'])('LOG_LEVEL=%s overrides it', (value) => {
    expect(loadConfig({ LOG_LEVEL: value }).logLevel).toBe(value);
  });

  test.each(['', 'loud', 'INFO'])('LOG_LEVEL=%s is refused, naming the accepted levels', (value) => {
    expect(() => loadConfig({ LOG_LEVEL: value })).toThrow(/LOG_LEVEL must be one of .*silent/);
  });
});
