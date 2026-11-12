/**
 * The service's metrics over prom-client, in a registry of their own per
 * application — the tests run several in one process. Implements the metrics
 * ports of the other modules. Every series of a known label combination —
 * derived from the enums, never listed by hand — exists from the start, at 0.
 *
 * The outbox gauges, read from the database, and the DLQ depth, read from SQS,
 * are read on each scrape, bounded in time: a read that fails or hangs keeps
 * its gauges at their last value and is logged, so the rest of the registry is
 * still scraped while a dependency is down (`ARCHITECTURE.md` §
 * Observabilidade).
 *
 * @packageDocumentation
 */
import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { ConsumerMetrics } from '../../messaging/application/consumer-metrics.ts';
import type { OutboxBacklog } from '../../messaging/application/outbox-backlog.ts';
import {
  LOCK_CONFLICT_REASONS,
  TRANSIENT_FAILURE_CODES,
  type LockConflictReason,
} from '../../shared/application/infrastructure-failures.ts';
import { FailureCode } from '../../shared/domain/failure-code.ts';
import { SubmissionChannel } from '../../wagering/domain/rejected-submission.ts';
import { WagerTransactionKind, WagerTransactionStatus } from '../../wagering/domain/wager-transaction.ts';
import type { WagerTransactionObservation, WageringMetrics } from '../../wagering/application/wagering-metrics.ts';
import type { ReconciliationDivergenceCounter } from '../../wallet/application/reconciliation.ts';

/** Latency buckets, in seconds: a submission takes milliseconds, up to the 2 s lock timeout. */
const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5];

/** The kinds a provider sends: the opening credit is not a submission. */
const PROVIDER_KINDS = Object.values(WagerTransactionKind).filter((kind) => kind !== WagerTransactionKind.Opening);
/** The statuses a new transaction is counted with: `PENDING` never outlives its unit of work. */
const COUNTED_STATUSES = Object.values(WagerTransactionStatus).filter(
  (status) => status !== WagerTransactionStatus.Pending,
);
const CHANNELS = Object.values(SubmissionChannel);
const FAILURE_CODES = Object.values(FailureCode);

/** Where a failed read is reported. */
export interface MetricsLog {
  warn(message: string): void;
}

export interface BacklogReadOptions {
  /** How long a scrape waits for a read before keeping the last value. */
  timeoutMs: number;
  log: MetricsLog;
}

/** What the metrics read on each scrape. */
export interface MetricsSources {
  /** The outbox backlog, from the database. */
  readBacklog(): Promise<OutboxBacklog>;
  /** How many messages wait in the DLQ of the wager transactions. */
  readDlqDepth(): Promise<number>;
}

/**
 * A read made on each scrape, bounded in time, keeping its last value when it
 * fails: one read in flight at a time, shared by every gauge of the scrape.
 */
class BoundedRead<T> {
  private inFlight: Promise<T> | undefined;

  constructor(
    private readonly what: string,
    private readonly read: () => Promise<T>,
    private last: T,
    private readonly options: BacklogReadOptions,
  ) {}

  /** The read in flight, or a new one. */
  current(): Promise<T> {
    this.inFlight ??= this.bounded().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async bounded(): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`timed out after ${this.options.timeoutMs} ms`)),
        this.options.timeoutMs,
      );
    });
    try {
      this.last = await Promise.race([this.read(), timeout]);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.options.log.warn(`${this.what} read failed, keeping the last value: ${reason}`);
    } finally {
      clearTimeout(timer);
    }
    return this.last;
  }
}

/** Every combination of the given label values, as label sets. */
function combinations<L extends string>(values: Record<L, readonly string[]>): Record<L, string>[] {
  const entries = Object.entries(values) as [L, readonly string[]][];
  let sets: Partial<Record<L, string>>[] = [{}];
  for (const [label, options] of entries) {
    sets = sets.flatMap((set) => options.map((option) => ({ ...set, [label]: option })));
  }
  return sets as Record<L, string>[];
}

/** Creates every given series of the counter at 0. */
function zero<L extends string>(counter: Counter<L>, values: Record<L, readonly string[]>): void {
  for (const labels of combinations(values)) counter.inc(labels, 0);
}

export class PrometheusMetrics implements WageringMetrics, ConsumerMetrics, ReconciliationDivergenceCounter {
  readonly registry = new Registry();
  private readonly transactions: Counter<'kind' | 'status' | 'channel'>;
  private readonly replays: Counter<'channel'>;
  private readonly idempotencyConflicts: Counter<'channel'>;
  private readonly notAdmitted: Counter<'failure_code' | 'channel'>;
  private readonly inboxDuplicates: Counter;
  private readonly consumerRetries: Counter<'failure_code'>;
  private readonly deadLetters: Counter<'failure_code'>;
  private readonly lockConflicts: Counter<'reason'>;
  private readonly latency: Histogram<'channel' | 'kind'>;
  private readonly divergences: Counter;

  /**
   * @param sources - What is read on each scrape: the outbox backlog, the DLQ depth.
   * @param options - The reads' time limit and where their failures are logged.
   */
  constructor(sources: MetricsSources, options: BacklogReadOptions) {
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
    this.inboxDuplicates = new Counter({
      name: 'inbox_duplicates_total',
      help: 'Queue messages the inbox already held, acknowledged without processing.',
      registers,
    });
    this.consumerRetries = new Counter({
      name: 'wager_transactions_consumer_retries_total',
      help: 'Deliveries of the input queue left for a later one, by the failure code that stopped them.',
      labelNames: ['failure_code'],
      registers,
    });
    this.deadLetters = new Counter({
      name: 'wager_transactions_dlq_messages_total',
      help: 'Messages the consumer sent to the DLQ, by failureCode.',
      labelNames: ['failure_code'],
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
    zero(this.transactions, { kind: PROVIDER_KINDS, status: COUNTED_STATUSES, channel: CHANNELS });
    zero(this.replays, { channel: CHANNELS });
    zero(this.idempotencyConflicts, { channel: CHANNELS });
    zero(this.notAdmitted, { failure_code: FAILURE_CODES, channel: CHANNELS });
    zero(this.consumerRetries, { failure_code: TRANSIENT_FAILURE_CODES });
    zero(this.deadLetters, { failure_code: FAILURE_CODES });
    zero(this.lockConflicts, { reason: LOCK_CONFLICT_REASONS });

    // Both gauges are collected in the same scrape: they share one read.
    const backlogRead = new BoundedRead('outbox backlog', sources.readBacklog, { pending: 0, lagSeconds: 0 }, options);
    const backlog = () => backlogRead.current();
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
    const dlqDepth = new BoundedRead('DLQ depth', sources.readDlqDepth, 0, options);
    new Gauge({
      name: 'wager_transactions_dlq_depth',
      help: 'Messages waiting in the DLQ of the wager transactions (ApproximateNumberOfMessages), redrives included.',
      registers,
      async collect() {
        this.set(await dlqDepth.current());
      },
    });
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

  inboxDuplicate(): void {
    this.inboxDuplicates.inc();
  }

  consumerRetry(failureCode: string): void {
    this.consumerRetries.inc({ failure_code: failureCode });
  }

  deadLettered(failureCode: string): void {
    this.deadLetters.inc({ failure_code: failureCode });
  }

  increment(): void {
    this.divergences.inc();
  }
}
