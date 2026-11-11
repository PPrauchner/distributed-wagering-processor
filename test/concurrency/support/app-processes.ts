/**
 * Process harness of the concurrency suite: runs the real app — `src/main.ts`
 * — in processes of its own, by `Bun.spawn`, each with its port, queues, fault
 * points and short times by environment variable, and waits for its
 * `/health/ready`. A process can be killed abruptly, with `SIGKILL`.
 *
 * The children inherit the environment of the test run, where the preload
 * pointed `DATABASE_URL` at the test database; every worker of the app is off
 * there unless the instance turns it on.
 *
 * @packageDocumentation
 */
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Subprocess } from 'bun';
import { waitUntil } from './wait-until.ts';

/** Where each instance's stdout and stderr go, one file per instance. */
export const LOG_DIR = join(tmpdir(), 'wagering-concurrency-logs');

export interface InstanceOptions {
  inputQueue: string;
  dlq: string;
  eventsQueue: string;
  consumer?: boolean;
  publisher?: boolean;
  pendingReferencesWorker?: boolean;
  /** `FAULT_INJECTION` points, e.g. `crash-after-commit`. */
  faults?: string[];
  /** Any other variable, overriding the defaults below. */
  env?: Record<string, string>;
}

export interface AppInstance {
  name: string;
  url: string;
  process: Subprocess;
  /** Ends the process at once, with no chance to finish anything. */
  kill(): Promise<void>;
}

const running = new Set<AppInstance>();
let sequence = 0;

/**
 * @param options - The queues, the workers on and the faults of the instance.
 * @returns The instance, ready: its `/health/ready` answered 200.
 */
export async function startInstance(options: InstanceOptions): Promise<AppInstance> {
  mkdirSync(LOG_DIR, { recursive: true });
  const port = freePort();
  sequence += 1;
  const name = `app-${process.pid}-${sequence}-${port}`;
  const log = Bun.file(join(LOG_DIR, `${name}.log`));
  const child = Bun.spawn(['bun', 'src/main.ts'], {
    env: {
      ...process.env,
      PORT: String(port),
      WAGER_TRANSACTIONS_QUEUE: options.inputQueue,
      WAGER_TRANSACTIONS_DLQ: options.dlq,
      WAGERING_EVENTS_QUEUE: options.eventsQueue,
      WAGER_TRANSACTIONS_CONSUMER_ENABLED: String(options.consumer ?? false),
      OUTBOX_PUBLISHER_ENABLED: String(options.publisher ?? false),
      PENDING_REFERENCES_WORKER_ENABLED: String(options.pendingReferencesWorker ?? false),
      FAULT_INJECTION: (options.faults ?? []).join(','),
      WAGER_TRANSACTIONS_WAIT_SECONDS: '1',
      WAGER_TRANSACTIONS_VISIBILITY_SECONDS: '5',
      WAGER_TRANSACTIONS_RETRY_MAX_SECONDS: '1',
      OUTBOX_POLL_INTERVAL_MS: '100',
      OUTBOX_LEASE_MS: '2000',
      OUTBOX_RETRY_BASE_MS: '100',
      OUTBOX_RETRY_MAX_MS: '1000',
      PENDING_REFERENCES_POLL_INTERVAL_MS: '100',
      PENDING_REFERENCES_LEASE_MS: '2000',
      PENDING_REFERENCES_RETRY_BASE_MS: '50',
      PENDING_REFERENCES_RETRY_MAX_MS: '500',
      PENDING_REFERENCE_TTL_MS: '120000',
      ...options.env,
    },
    stdout: log,
    stderr: log,
  });
  const instance: AppInstance = {
    name,
    url: `http://127.0.0.1:${port}`,
    process: child,
    async kill() {
      running.delete(instance);
      child.kill('SIGKILL');
      await child.exited;
    },
  };
  running.add(instance);
  try {
    await waitUntil(
      async () => {
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`${name} exited before it was ready; see ${LOG_DIR}`);
        }
        const response = await fetch(`${instance.url}/health/ready`).catch(() => undefined);
        return response?.status === 200 ? true : undefined;
      },
      30_000,
      `${name} ready`,
    );
  } catch (error) {
    await instance.kill();
    throw error;
  }
  return instance;
}

/** Kills every instance still running; for `afterEach`/`afterAll`. */
export async function killAllInstances(): Promise<void> {
  await Promise.all([...running].map((instance) => instance.kill()));
}

/** A port free right now: the OS picks it, and it is released for the child. */
function freePort(): number {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() });
  const { port } = server;
  server.stop(true);
  return port!;
}
