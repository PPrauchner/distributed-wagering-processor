/**
 * `WalletRepository` and `WalletLedgerRepository` ports, the ledger snapshot a
 * reconciliation reads, and the repositories
 * the wallet use cases need from a unit of work.
 *
 * @packageDocumentation
 */
import type { Wallet } from '../domain/wallet.ts';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry.ts';

export interface WalletRepository {
  findById(id: string): Promise<Wallet | null>;
  /**
   * Reads the wallet under `SELECT … FOR UPDATE`, held until the unit of work
   * ends: the first lock of every unit of work that moves a balance (ADR 0002).
   */
  findByIdForUpdate(id: string): Promise<Wallet | null>;
  findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null>;
  /** The wallet created with this `Idempotency-Key`, if any. */
  findByCreationIdempotencyKey(idempotencyKey: string): Promise<Wallet | null>;
  /** Registers a new wallet; it is written when the unit of work commits. */
  add(wallet: Wallet): void;
}

export interface WalletLedgerRepository {
  /** Registers a new entry; it is written when the unit of work commits. */
  add(entry: WalletLedgerEntry): void;
  /**
   * @param walletId - The wallet whose ledger is read.
   * @param afterVersion - Only entries with a greater wallet version; 0 for the start.
   * @param limit - The most entries returned.
   * @returns The entries, in ascending wallet version.
   */
  findPage(walletId: string, afterVersion: number, limit: number): Promise<WalletLedgerEntry[]>;
  /**
   * Reads, in one statement and without locking, what a reconciliation compares.
   *
   * @param walletId - The wallet to reconcile.
   * @returns The snapshot, or null when the wallet does not exist.
   */
  reconcile(walletId: string): Promise<LedgerSnapshot | null>;
}

/** A range of wallet versions with no ledger entry, both ends included. */
export interface VersionGap {
  from: number;
  to: number;
}

/** Stored balance and ledger summary of one wallet, from a single snapshot. */
export interface LedgerSnapshot {
  walletId: string;
  currency: string;
  /** Decimal strings with 2 places; the sums may be negative when divergent. */
  storedBalance: string;
  calculatedBalance: string;
  difference: string;
  checkedEntries: number;
  versionGaps: VersionGap[];
  walletVersion: number;
  /** The highest version among the entries; `null` when there is none. */
  lastEntryVersion: number | null;
}

export interface WalletRepositories {
  wallets: WalletRepository;
  ledger: WalletLedgerRepository;
}
