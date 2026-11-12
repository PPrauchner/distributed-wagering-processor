/**
 * The loop of the worker of pending references on one instance: a cycle every
 * poll interval — right away again after a full batch — until the application
 * shuts down. Then it stops claiming, tells the cycle in flight to leave the
 * items it has not started — still leased, they are claimed again when the
 * lease expires — and waits for the item in progress, whose SQL transaction is
 * atomic. A failed cycle is logged and retried on the next tick.
 *
 * @packageDocumentation
 */
import { Logger, type BeforeApplicationShutdown, type OnApplicationBootstrap } from '@nestjs/common';
import { describeError } from '../../shared/application/error-summary.ts';
import { waitAtMost } from '../../shared/application/wait-at-most.ts';
import {
  PENDING_REFERENCES_BATCH_SIZE,
  type ResolvePendingReferences,
} from '../application/resolve-pending-references.ts';

/** How long a shutdown waits for the cycle in flight, by default — inside the Compose's 30 s grace period. */
const DEFAULT_DRAIN_TIMEOUT_MS = 20_000;

export interface PendingReferencesWorkerOptions {
  enabled: boolean;
  pollIntervalMs: number;
  /** How long a shutdown waits for the cycle in flight; 20 s by default. */
  drainTimeoutMs?: number;
}

export class PendingReferencesWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('PendingReferencesWorker');
  private running = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly resolvePendingReferences: ResolvePendingReferences,
    private readonly options: PendingReferencesWorkerOptions,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.options.enabled) return;
    this.running = true;
    this.loop = this.run();
  }

  // Before the shutdown hooks, where the ORM closes: the item in progress ends on an open pool.
  async beforeApplicationShutdown(): Promise<void> {
    this.running = false;
    this.wake?.();
    if (!this.loop) return;
    const drainTimeoutMs = this.options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
    if (!(await waitAtMost(this.loop, drainTimeoutMs))) {
      this.logger.warn(`pending references cycle still in flight after ${drainTimeoutMs} ms; shutting down`);
    }
  }

  private async run(): Promise<void> {
    while (this.running) {
      let claimed = 0;
      try {
        claimed = await this.resolvePendingReferences.resolveDue(() => !this.running);
      } catch (error) {
        this.logger.warn(`pending references cycle failed: ${describeError(error)}`);
      }
      if (this.running && claimed < PENDING_REFERENCES_BATCH_SIZE) await this.pause();
    }
  }

  /** Waits for the poll interval, or less if the application shuts down. */
  private pause(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, this.options.pollIntervalMs);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}
