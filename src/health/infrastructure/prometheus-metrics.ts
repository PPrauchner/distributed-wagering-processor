/**
 * The service's metrics over prom-client, in a registry of their own per
 * application — the tests run several in one process. Implements the metrics
 * ports of the other modules; the outbox gauges are read from the database on
 * each scrape, bounded in time: a read that fails or hangs keeps the gauges at
 * their last value and is logged, so the rest of the registry is still scraped
 * while the database is down (`ARCHITECTURE.md` § Observabilidade).
 *
 * @packageDocumentation
 */
import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { OutboxBacklog } from '../../messaging/application/outbox-backlog.ts';
import type { LockConflictReason } from '../../shared/application/infrastructure-failures.ts';
import type { SubmissionChannel } from '../../wagering/domain/rejected-submission.ts';
import type { WagerTransactionObservation, WageringMetrics } from '../../wagering/application/wagering-metrics.ts';
import type { ReconciliationDivergenceCounter } from '../../wallet/application/reconciliation.ts';

/** Latency buckets, in seconds: a submission takes milliseconds, up to the 2 s lock timeout. */
const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5];

/** Where a failed backlog read is reported. */
export interface MetricsLog {
  warn(message: string): void;
}

export interface BacklogReadOptions {
  /** How long a scrape waits for the backlog before keeping the last value. */
  timeoutMs: number;
  log: MetricsLog;
}

export class PrometheusMetrics implements WageringMetrics, ReconciliationDivergenceCounter {
  readonly registry = new Registry();
  private readonly transactions: Counter<'kind' | 'status' | 'channel'>;
  private readonly replays: Counter<'channel'>;
  private readonly idempotencyConflicts: Counter<'channel'>;
  private readonly notAdmitted: Counter<'failure_code' | 'channel'>;
  private readonly lockConflicts: Counter<'reason'>;
  private readonly latency: Histogram<'channel' | 'kind'>;
  private readonly divergences: Counter;
  private lastBacklog: OutboxBacklog = { pending: 0, lagSeconds: 0 };
  /** The read in flight, shared by both gauges of one scrape. */
  private backlogInFlight: Promise<OutboxBacklog> | undefined;

  /**
   * @param readBacklog - Reads the outbox backlog; called on each scrape.
   * @param options - The read's time limit and where its failures are logged.
   */
  constructor(
    private readonly readBacklog: () => Promise<OutboxBacklog>,
    private readonly options: BacklogReadOptions,
  ) {
    const registers = [this.registry];
    this.transactions = new Counter({
      name: 'wager_transactions_total',
      help: 'New wager transactions, by kind, final status and channel.',
      labelNames: ['kind', 'status', 'channel'],
      registers,
    });
    this.replays = new Counter({
      name: 'wager_transaction_idempotent_replays_total',
      help: 'Submissions answered with the transaction already recorded under their key.',
      labelNames: ['channel'],
      registers,
    });
    this.idempotencyConflicts = new Counter({
      name: 'wager_transaction_idempotency_conflicts_total',
      help: 'Submissions reusing an idempotency key with another payload.',
      labelNames: ['channel'],
      registers,
    });
    this.notAdmitted = new Counter({
      name: 'rejected_submissions_total',
      help: 'Submissions not admitted, by failure code and channel.',
      labelNames: ['failure_code', 'channel'],
      registers,
    });
    new Counter({
      name: 'inbox_duplicates_total',
      help: 'Queue messages the inbox already held, acknowledged without processing.',
      registers,
    });
    this.lockConflicts = new Counter({
      name: 'lock_conflicts_total',
      help: 'Wallet lock conflicts, by reason: lock_timeout, deadlock, serialization_failure.',
      labelNames: ['reason'],
      registers,
    });
    this.latency = new Histogram({
      name: 'wager_transaction_processing_seconds',
      help: 'Processing time of a submission that ended in a transaction, by channel and kind.',
      labelNames: ['channel', 'kind'],
      buckets: LATENCY_BUCKETS,
      registers,
    });
    this.divergences = new Counter({
      name: 'reconciliation_divergences_total',
      help: 'Reconciliations that found the stored balance or the ledger sequence divergent.',
      registers,
    });
    // Both gauges are collected in the same scrape: they share one read.
    const backlog = () => this.sharedBacklog();
    new Gauge({
      name: 'outbox_pending',
      help: 'Outbox messages not published yet.',
      registers,
      async collect() {
        this.set((await backlog()).pending);
      },
    });
    new Gauge({
      name: 'outbox_lag_seconds',
      help: 'Age of the oldest outbox message not published yet; 0 when there is none.',
      registers,
      async collect() {
        this.set((await backlog()).lagSeconds);
      },
    });
  }

  /** The read in flight, or a new one: one read per scrape, one snapshot for both gauges. */
  private sharedBacklog(): Promise<OutboxBacklog> {
    this.backlogInFlight ??= this.boundedBacklog().finally(() => {
      this.backlogInFlight = undefined;
    });
    return this.backlogInFlight;
  }

  /** The backlog read within the time limit, or the last one read when it fails. */
  private async boundedBacklog(): Promise<OutboxBacklog> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`timed out after ${this.options.timeoutMs} ms`)),
        this.options.timeoutMs,
      );
    });
    try {
      this.lastBacklog = await Promise.race([this.readBacklog(), timeout]);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.options.log.warn(`outbox backlog read failed, keeping the last value: ${reason}`);
    } finally {
      clearTimeout(timer);
    }
    return this.lastBacklog;
  }

  transactionSettled(observation: WagerTransactionObservation): void {
    const { channel, kind, status, idempotentReplay, durationSeconds } = observation;
    if (idempotentReplay) this.replays.inc({ channel });
    else this.transactions.inc({ kind, status, channel });
    this.latency.observe({ channel, kind }, durationSeconds);
  }

  idempotencyConflict(channel: SubmissionChannel): void {
    this.idempotencyConflicts.inc({ channel });
  }

  lockConflict(reason: LockConflictReason): void {
    this.lockConflicts.inc({ reason });
  }

  submissionNotAdmitted(failureCode: string, channel: SubmissionChannel): void {
    this.notAdmitted.inc({ failure_code: failureCode, channel });
  }

  increment(): void {
    this.divergences.inc();
  }
}
