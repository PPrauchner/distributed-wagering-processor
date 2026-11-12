/**
 * The one way the integration and concurrency suites wait: for a condition,
 * with a timeout — never for a fixed time.
 *
 * @packageDocumentation
 */

const POLL_MS = 25;
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Polls `probe` until it returns something other than `undefined`.
 *
 * @param probe - The condition; `undefined` means "not yet".
 * @param timeoutMs - How long to wait before failing.
 * @param label - What is awaited, for the timeout's message.
 * @returns What the probe returned.
 * @throws {@link Error} If the condition is not met in time.
 */
export async function waitUntil<T>(
  probe: () => Promise<T | undefined>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  label = 'condition',
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`${label} not met within ${timeoutMs} ms`);
    await Bun.sleep(POLL_MS);
  }
}
