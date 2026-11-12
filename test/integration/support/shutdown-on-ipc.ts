/**
 * Preload of the app processes the integration tests spawn: on the IPC
 * message `SIGTERM`, raises `SIGTERM` in the process, through the very
 * listeners `enableShutdownHooks` registered. Windows has no POSIX signals —
 * `kill('SIGTERM')` there terminates the process at once —, so the tests
 * deliver the signal this way on it, and as a real signal elsewhere.
 *
 * Usage: `bun --preload ./test/integration/support/shutdown-on-ipc.ts src/main.ts`,
 * spawned with an `ipc` channel.
 *
 * @packageDocumentation
 */
process.on('message', (message) => {
  if (message === 'SIGTERM') process.emit('SIGTERM', 'SIGTERM');
});
