/**
 * `Reconciliation`: compares a wallet's stored balance with the balance rebuilt
 * from its ledger, and looks for gaps in the entries' version sequence
 * (ADR 0003). Read only — no lock, nothing written, one snapshot. A divergence
 * is reported, logged and counted, never corrected.
 *
 * @packageDocumentation
 */
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
  /** Zero difference and no gap. */
  consistent: boolean;
  checkedEntries: number;
  /** Ranges of missing versions, in ascending order. */
  versionGaps: VersionGap[];
}

/** Counts divergences; the observability slice exposes it as a metric. */
export interface ReconciliationDivergenceCounter {
  increment(): void;
}

/** Where divergences are reported. */
export interface ReconciliationLog {
  error(message: string): void;
}

/** Default counter: keeps the count in the process until a metric is wired. */
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
      this.log.error(`reconciliation divergence on wallet ${report.walletId}`);
      this.divergences.increment();
    }
    return report;
  }
}

function toReport(snapshot: LedgerSnapshot): ReconciliationReport {
  const { currency } = snapshot;
  const difference = signedMoney(snapshot.difference, currency);
  return {
    walletId: snapshot.walletId,
    storedBalance: signedMoney(snapshot.storedBalance, currency),
    calculatedBalance: signedMoney(snapshot.calculatedBalance, currency),
    difference,
    consistent: difference.isZero() && snapshot.versionGaps.length === 0,
    checkedEntries: snapshot.checkedEntries,
    versionGaps: snapshot.versionGaps,
  };
}

// A divergent ledger may sum below zero, which `Money.from` refuses on input.
function signedMoney(amount: string, currency: string): Money {
  return amount.startsWith('-')
    ? Money.from({ amount: amount.slice(1), currency }).negate()
    : Money.from({ amount, currency });
}
