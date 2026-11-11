/**
 * The backoff of a transaction waiting for its reference (`ARCHITECTURE.md` §
 * Referências fora de ordem): the worker tries it again after
 * `min(base × 2^attempts, max)`, ±20% jitter.
 *
 * @packageDocumentation
 */

/** How long a pending reference waits for its next attempt. */
export interface ReferenceRetryBackoff {
  baseMs: number;
  maxMs: number;
  /** A number in [0, 1); `Math.random` by default. */
  random?: () => number;
}

const JITTER = 0.2;

/**
 * @param attempts - The attempts already counted.
 * @param backoff - Base, cap and randomness of the delay.
 * @returns The delay before the next attempt, in milliseconds.
 */
export function referenceRetryDelayMs(attempts: number, backoff: ReferenceRetryBackoff): number {
  const random = backoff.random ?? Math.random;
  // 2^attempts overflows to Infinity long before it matters; the cap holds.
  const delay = Math.min(backoff.baseMs * 2 ** attempts, backoff.maxMs);
  return Math.round(delay * (1 - JITTER + 2 * JITTER * random()));
}
