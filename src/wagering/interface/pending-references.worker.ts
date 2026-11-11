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
import {
  PENDING_REFERENCES_BATCH_SIZE,
  type ResolvePendingReferences,
} from '../application/resolve-pending-references.ts';

export interface PendingReferencesWorkerOptions {
  enabled: boolean;
  pollIntervalMs: number;
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
    await this.loop;
  }

  private async run(): Promise<void> {
    while (this.running) {
      let claimed = 0;
      try {
        claimed = await this.resolvePendingReferences.resolveDue(() => !this.running);
      } catch (error) {
        this.logger.warn(`pending references cycle failed: ${error instanceof Error ? error.message : String(error)}`);
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
