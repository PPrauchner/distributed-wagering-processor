/**
 * `OpeningRecorder` port: how the creation of a wallet records the opening
 * that credits its initial balance — the internal `OPENING` transaction and
 * its outcome event — without `wallet` depending on `wagering`, which
 * implements it. The composition root binds the two ends
 * (`ARCHITECTURE.md` § Organização do código).
 *
 * @packageDocumentation
 */
import type { Wallet } from '../domain/wallet.ts';

/** Injection token of the opening recorder. */
export const OPENING_RECORDER = Symbol('OpeningRecorder');

/** The opening of a wallet just opened with a positive balance. */
export interface WalletOpening {
  /** The id of the `OPENING` transaction; the opening ledger entry already names it. */
  transactionId: string;
  wallet: Wallet;
  correlationId: string;
}

/**
 * @typeParam TRepositories - The repositories it writes to, bound to the
 *   creation's unit of work.
 */
export interface OpeningRecorder<TRepositories> {
  /**
   * Records the opening in the creation's unit of work: committed with the
   * wallet and its entry, or not at all.
   *
   * @param repositories - The repositories of the creation's unit of work.
   * @param opening - The wallet, the opening's transaction id and correlation id.
   */
  record(repositories: TRepositories, opening: WalletOpening): void;
}
