/**
 * `Reconciliation`: compares a wallet's stored balance with the balance rebuilt
 * from its ledger, and looks for gaps in the entries' version sequence
 * (ADR 0003), and for entries above the wallet version. Read only — no lock, nothing written, one snapshot. A divergence
 * is reported, logged and counted, never corrected.
 *
 * @packageDocumentation
 */
import type { ContextLog } from '../../shared/application/context-log.ts';
import type { UnitOfWork } from '../../shared/application/unit-of-work.ts';
import { Money } from '../../shared/domain/money.ts';
import type { LedgerSnapshot, VersionGap, WalletRepositories } from './wallet-repository.ts';
import { WalletNotFoundError } from './wallet-errors.ts';
import { isWalletIdFormat } from './wallet-id.ts';

export interface ReconciliationReport {
  walletId: string;
  storedBalance: Money;
  calculatedBalance: Money;
  /** Stored minus calculated. */
  difference: Money;
  /** Zero difference, no gap and no entry above the wallet version. */
  consistent: boolean;
  checkedEntries: number;
  /** Ranges of missing versions, in ascending order. */
  versionGaps: VersionGap[];
  walletVersion: number;
  /** The highest version among the entries; `null` when there is none. */
  lastEntryVersion: number | null;
}

/** Injection token of the divergence counter: the metrics bind it. */
export const RECONCILIATION_DIVERGENCE_COUNTER = Symbol('ReconciliationDivergenceCounter');

/** Counts divergences; exposed as the `reconciliation_divergences_total` metric. */
export interface ReconciliationDivergenceCounter {
  increment(): void;
}

/** Where divergences are reported, as an alert with the wallet's id as a field. */
export type ReconciliationLog = Pick<ContextLog, 'warn'>;

/** A counter kept in the process, for the tests that run the use case alone. */
export class InMemoryReconciliationDivergenceCounter implements ReconciliationDivergenceCounter {
  private divergences = 0;

  get count(): number {
    return this.divergences;
  }

  increment(): void {
    this.divergences++;
  }
}

export class Reconciliation {
  constructor(
    private readonly unitOfWork: UnitOfWork<WalletRepositories>,
    private readonly divergences: ReconciliationDivergenceCounter,
    private readonly log: ReconciliationLog,
  ) {}

  /**
   * @param walletId - The wallet to reconcile.
   * @returns The report; a divergence is in it, not thrown.
   * @throws {@link WalletNotFoundError} If the wallet id is malformed or unknown.
   */
  async execute(walletId: string): Promise<ReconciliationReport> {
    if (!isWalletIdFormat(walletId)) throw new WalletNotFoundError(walletId);
    const snapshot = await this.unitOfWork.run(({ ledger }) => ledger.reconcile(walletId));
    if (!snapshot) throw new WalletNotFoundError(walletId);

    const report = toReport(snapshot);
    if (!report.consistent) {
      // Values stay out of the log: the report carries them.
      this.log.warn('reconciliation divergence', { walletId: report.walletId });
      this.divergences.increment();
    }
    return report;
  }
}

function toReport(snapshot: LedgerSnapshot): ReconciliationReport {
  const { currency } = snapshot;
  // Read back from the database: past the input ceiling, maybe negative when divergent.
  const persisted = (amount: string): Money => Money.fromPersisted({ amount, currency });
  const difference = persisted(snapshot.difference);
  return {
    walletId: snapshot.walletId,
    storedBalance: persisted(snapshot.storedBalance),
    calculatedBalance: persisted(snapshot.calculatedBalance),
    difference,
    consistent: difference.isZero() && snapshot.versionGaps.length === 0 && !hasEntryAboveVersion(snapshot),
    checkedEntries: snapshot.checkedEntries,
    versionGaps: snapshot.versionGaps,
    walletVersion: snapshot.walletVersion,
    lastEntryVersion: snapshot.lastEntryVersion,
  };
}

function hasEntryAboveVersion(snapshot: LedgerSnapshot): boolean {
  return snapshot.lastEntryVersion !== null && snapshot.lastEntryVersion > snapshot.walletVersion;
}
