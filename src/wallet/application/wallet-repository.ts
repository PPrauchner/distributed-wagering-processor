/**
 * `WalletRepository` and `WalletLedgerRepository` ports, and the repositories
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
  /** Registers a new wallet; it is written when the unit of work commits. */
  add(wallet: Wallet): void;
}

export interface WalletLedgerRepository {
  /** Registers a new entry; it is written when the unit of work commits. */
  add(entry: WalletLedgerEntry): void;
}

export interface WalletRepositories {
  wallets: WalletRepository;
  ledger: WalletLedgerRepository;
}
