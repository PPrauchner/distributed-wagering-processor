/**
 * Service configuration, read from the environment.
 *
 * @packageDocumentation
 */

export interface AppConfig {
  databaseUrl: string;
  port: number;
  /** The `Retry-After` of a transient failure's 503, in seconds. */
  retryAfterSeconds: number;
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
 *   `RETRY_AFTER_SECONDS` is not a positive integer.
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
  return { databaseUrl: env.DATABASE_URL ?? DEFAULT_DATABASE_URL, port, retryAfterSeconds };
}
