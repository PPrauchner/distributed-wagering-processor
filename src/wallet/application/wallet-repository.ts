/**
 * `WalletRepository` port and the repositories the wallet use cases need from a
 * unit of work.
 *
 * @packageDocumentation
 */
import type { Wallet } from '../domain/wallet.ts';

export interface WalletRepository {
  findById(id: string): Promise<Wallet | null>;
  findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null>;
  /** Registers a new wallet; it is written when the unit of work commits. */
  add(wallet: Wallet): void;
}

export interface WalletRepositories {
  wallets: WalletRepository;
}
