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
}

export interface SqsConfig {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** The input queue of the submissions; the readiness check looks it up. */
  wagerTransactionsQueue: string;
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
 *   `RETRY_AFTER_SECONDS` or a time of the outbox publisher is not a positive
 *   integer, or `OUTBOX_PUBLISHER_ENABLED` is neither `true` nor `false`, or
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
      wageringEventsQueue: env.WAGERING_EVENTS_QUEUE ?? 'wagering-events.fifo',
    },
    outboxPublisher: {
      enabled: booleanOf(env, 'OUTBOX_PUBLISHER_ENABLED', true),
      pollIntervalMs: positiveIntegerOf(env, 'OUTBOX_POLL_INTERVAL_MS', 500),
      leaseMs: positiveIntegerOf(env, 'OUTBOX_LEASE_MS', 30_000),
      retryBaseMs: positiveIntegerOf(env, 'OUTBOX_RETRY_BASE_MS', 1000),
      retryMaxMs: positiveIntegerOf(env, 'OUTBOX_RETRY_MAX_MS', 5 * 60_000),
    },
  };
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
