/**
 * Service configuration, read from the environment.
 *
 * @packageDocumentation
 */
import { FaultPoint } from './shared/application/fault-injector.ts';

export interface AppConfig {
  databaseUrl: string;
  port: number;
  /** The `Retry-After` of a transient failure's 503, in seconds. */
  retryAfterSeconds: number;
  /** The enabled fault points; empty — no fault — unless `FAULT_INJECTION` says so. */
  faultPoints: FaultPoint[];
  sqs: SqsConfig;
  outboxPublisher: OutboxPublisherConfig;
  wagerTransactionsConsumer: WagerTransactionsConsumerConfig;
  pendingReferences: PendingReferencesConfig;
}

export interface SqsConfig {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** The input queue of the submissions; the readiness check looks it up. */
  wagerTransactionsQueue: string;
  /** Where the consumer sends the messages it gives up on, with their `failureCode`. */
  wagerTransactionsDlq: string;
  /** Where the integration events go; the tests use queues with a random suffix. */
  wageringEventsQueue: string;
}

/** The outbox publisher of every instance (`ARCHITECTURE.md` § Publicador da outbox). */
export interface OutboxPublisherConfig {
  /** Whether this instance runs the publisher; on by default. */
  enabled: boolean;
  pollIntervalMs: number;
  leaseMs: number;
  /** A failed publication waits `min(retryBaseMs × 2^attempts, retryMaxMs)`, with jitter. */
  retryBaseMs: number;
  retryMaxMs: number;
}

/** The consumer of the input queue of every instance (`ARCHITECTURE.md` § Consumidor). */
export interface WagerTransactionsConsumerConfig {
  /** Whether this instance consumes the input queue; on by default. */
  enabled: boolean;
  /** The long polling wait of each receive, 0 to 20 s. */
  waitTimeSeconds: number;
  /** Messages per receive, 1 to 10, processed in parallel. */
  batchSize: number;
  /** How long a received message stays invisible to the other consumers. */
  visibilityTimeoutSeconds: number;
  /** The receive at which a transient failure is given up on: `FAILED` or the DLQ. */
  maxReceives: number;
  /** The ceiling of the retry backoff, `min(2^receiveCount s, retryMaxSeconds)`. */
  retryMaxSeconds: number;
  /** How long a shutdown waits for the messages in progress. */
  drainTimeoutMs: number;
}

/**
 * The transactions pending their reference, and the worker that resolves them
 * on every instance (`ARCHITECTURE.md` § Referências fora de ordem).
 */
export interface PendingReferencesConfig {
  /** Whether this instance runs the worker; on by default. */
  enabled: boolean;
  /** How long a pending reference waits from its creation, on the database clock. */
  ttlMs: number;
  pollIntervalMs: number;
  leaseMs: number;
  /** The next attempt waits `min(retryBaseMs × 2^attempts, retryMaxMs)`, with jitter. */
  retryBaseMs: number;
  retryMaxMs: number;
}

// 127.0.0.1 and never localhost: on Windows localhost tries IPv6 first and each
// new connection takes ~300 ms — enough to serialize transactions by accident
// and hide a race in the tests (ADR 0001).
const DEFAULT_DATABASE_URL = 'postgresql://wagering:wagering@127.0.0.1:55432/wagering';
const DEFAULT_PORT = 3000;
const DEFAULT_RETRY_AFTER_SECONDS = 1;

/**
 * @param env - Environment variables; the process environment by default.
 * @returns The configuration, with local-development defaults.
 * @throws {@link Error} If `PORT` is not a valid port number, or
 *   `RETRY_AFTER_SECONDS` or a time of the outbox publisher or of the pending
 *   references is not a positive integer, or `OUTBOX_PUBLISHER_ENABLED` or
 *   `PENDING_REFERENCES_WORKER_ENABLED` is neither `true` nor `false`, or a
 *   setting of the consumer is out of its range, or
 *   `FAULT_INJECTION` names an unknown point or is set in production.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const port = env.PORT === undefined ? DEFAULT_PORT : Number(env.PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be an integer between 0 and 65535, got "${env.PORT}"`);
  }
  const retryAfterSeconds =
    env.RETRY_AFTER_SECONDS === undefined ? DEFAULT_RETRY_AFTER_SECONDS : Number(env.RETRY_AFTER_SECONDS);
  if (!Number.isInteger(retryAfterSeconds) || retryAfterSeconds < 1) {
    throw new Error(`RETRY_AFTER_SECONDS must be a positive integer, got "${env.RETRY_AFTER_SECONDS}"`);
  }
  return {
    databaseUrl: env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
    port,
    retryAfterSeconds,
    faultPoints: faultPointsOf(env),
    // LocalStack's defaults; the endpoint by 127.0.0.1, like the database.
    sqs: {
      endpoint: env.SQS_ENDPOINT ?? 'http://127.0.0.1:4566',
      region: env.AWS_REGION ?? 'us-east-1',
      accessKeyId: env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? 'test',
      wagerTransactionsQueue: env.WAGER_TRANSACTIONS_QUEUE ?? 'wager-transactions.fifo',
      wagerTransactionsDlq: env.WAGER_TRANSACTIONS_DLQ ?? 'wager-transactions-dlq.fifo',
      wageringEventsQueue: env.WAGERING_EVENTS_QUEUE ?? 'wagering-events.fifo',
    },
    outboxPublisher: {
      enabled: booleanOf(env, 'OUTBOX_PUBLISHER_ENABLED', true),
      pollIntervalMs: positiveIntegerOf(env, 'OUTBOX_POLL_INTERVAL_MS', 500),
      leaseMs: positiveIntegerOf(env, 'OUTBOX_LEASE_MS', 30_000),
      retryBaseMs: positiveIntegerOf(env, 'OUTBOX_RETRY_BASE_MS', 1000),
      retryMaxMs: positiveIntegerOf(env, 'OUTBOX_RETRY_MAX_MS', 5 * 60_000),
    },
    // SQS's own limits: a wait of at most 20 s, at most 10 messages per receive.
    wagerTransactionsConsumer: {
      enabled: booleanOf(env, 'WAGER_TRANSACTIONS_CONSUMER_ENABLED', true),
      waitTimeSeconds: integerInRangeOf(env, 'WAGER_TRANSACTIONS_WAIT_SECONDS', 20, [0, 20]),
      batchSize: integerInRangeOf(env, 'WAGER_TRANSACTIONS_BATCH_SIZE', 10, [1, 10]),
      visibilityTimeoutSeconds: positiveIntegerOf(env, 'WAGER_TRANSACTIONS_VISIBILITY_SECONDS', 30),
      // Below the redrive's maxReceiveCount of 6, the safety net when even giving up fails.
      maxReceives: positiveIntegerOf(env, 'WAGER_TRANSACTIONS_MAX_RECEIVES', 5),
      retryMaxSeconds: positiveIntegerOf(env, 'WAGER_TRANSACTIONS_RETRY_MAX_SECONDS', 60),
      drainTimeoutMs: positiveIntegerOf(env, 'WAGER_TRANSACTIONS_DRAIN_TIMEOUT_MS', 20_000),
    },
    pendingReferences: {
      enabled: booleanOf(env, 'PENDING_REFERENCES_WORKER_ENABLED', true),
      ttlMs: positiveIntegerOf(env, 'PENDING_REFERENCE_TTL_MS', 5 * 60_000),
      pollIntervalMs: positiveIntegerOf(env, 'PENDING_REFERENCES_POLL_INTERVAL_MS', 1000),
      leaseMs: positiveIntegerOf(env, 'PENDING_REFERENCES_LEASE_MS', 30_000),
      retryBaseMs: positiveIntegerOf(env, 'PENDING_REFERENCES_RETRY_BASE_MS', 1000),
      retryMaxMs: positiveIntegerOf(env, 'PENDING_REFERENCES_RETRY_MAX_MS', 60_000),
    },
  };
}

function integerInRangeOf(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  [min, max]: [number, number],
): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}, got "${raw}"`);
  }
  return value;
}

function positiveIntegerOf(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer, got "${raw}"`);
  return value;
}

function booleanOf(env: Record<string, string | undefined>, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined) return fallback;
  if (raw !== 'true' && raw !== 'false') throw new Error(`${name} must be true or false, got "${raw}"`);
  return raw === 'true';
}

const FAULT_POINTS = new Set<string>(Object.values(FaultPoint));

// `FAULT_INJECTION`: comma-separated fault point names, for the tests only.
function faultPointsOf(env: Record<string, string | undefined>): FaultPoint[] {
  const names = (env.FAULT_INJECTION ?? '').split(',').map((name) => name.trim()).filter(Boolean);
  if (names.length === 0) return [];
  if (env.NODE_ENV === 'production') throw new Error('FAULT_INJECTION is not allowed in production');
  const unknown = names.find((name) => !FAULT_POINTS.has(name));
  if (unknown !== undefined) throw new Error(`FAULT_INJECTION names an unknown fault point: "${unknown}"`);
  return names as FaultPoint[];
}
