/**
 * The one way the concurrency suite waits: for a condition, with a timeout —
 * never for a fixed time.
 *
 * @packageDocumentation
 */

const POLL_MS = 25;

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
  timeoutMs: number,
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
