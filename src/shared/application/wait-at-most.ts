/**
 * Bounded wait for work in flight: a shutdown waits for it, but never past a
 * deadline — past it, the process must still exit inside the orchestrator's
 * grace period, and the leases and the SQL transaction's atomicity make the
 * abandoned work safe.
 *
 * @packageDocumentation
 */

/**
 * Waits for `work`, or for `timeoutMs`, whichever comes first.
 *
 * @param work - The work in flight; its rejection counts as finished.
 * @param timeoutMs - The longest wait.
 * @returns `true` if the work finished in time, `false` if the wait timed out.
 */
export async function waitAtMost(work: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finished = await Promise.race([
    work.then(
      () => true,
      () => true,
    ),
    new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), timeoutMs))),
  ]);
  clearTimeout(timer);
  return finished;
}
