/**
 * The outbox publisher loop of one instance: a cycle every poll interval —
 * right away again after a full batch — until the application shuts down,
 * when it stops claiming and waits for the cycle in flight. A failed cycle is
 * logged and retried on the next tick; the leases make an abandoned one safe.
 *
 * @packageDocumentation
 */
import { Logger, type BeforeApplicationShutdown, type OnApplicationBootstrap } from '@nestjs/common';
import { OUTBOX_BATCH_SIZE, type PublishOutbox } from '../application/publish-outbox.ts';

export interface OutboxPublisherWorkerOptions {
  enabled: boolean;
  pollIntervalMs: number;
}

export class OutboxPublisherWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('OutboxPublisher');
  private running = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly publishOutbox: PublishOutbox,
    private readonly options: OutboxPublisherWorkerOptions,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.options.enabled) return;
    this.running = true;
    this.loop = this.run();
  }

  // Before the shutdown hooks, where the ORM closes: the cycle in flight ends on an open pool.
  async beforeApplicationShutdown(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
  }

  private async run(): Promise<void> {
    while (this.running) {
      let claimed = 0;
      try {
        claimed = await this.publishOutbox.publishDue();
      } catch (error) {
        this.logger.warn(`outbox publication cycle failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      // A shutdown asked during the cycle does not wait out the poll interval.
      if (this.running && claimed < OUTBOX_BATCH_SIZE) await this.pause();
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
