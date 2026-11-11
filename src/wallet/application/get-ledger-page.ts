/**
 * Reads one page of a wallet's ledger, in ascending wallet version (ADR 0003).
 * The next page starts strictly after the last entry served, so pages already
 * read never change: entries written in between only show up further on.
 *
 * @packageDocumentation
 */
import type { UnitOfWork } from '../../shared/application/unit-of-work.ts';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry.ts';
import { decodeLedgerCursor, encodeLedgerCursor } from './ledger-cursor.ts';
import type { WalletRepositories } from './wallet-repository.ts';
import { WalletNotFoundError } from './wallet-errors.ts';
import { isWalletIdFormat } from './wallet-id.ts';

export interface GetLedgerPageQuery {
  walletId: string;
  /** The `nextCursor` of the previous page; absent for the first page. */
  cursor?: string;
  /** Between 1 and 200; checked by the caller. */
  limit: number;
}

export interface LedgerPage {
  items: WalletLedgerEntry[];
  /** Null when the page did not fill up: there was nothing more to read. */
  nextCursor: string | null;
}

export class GetLedgerPage {
  constructor(private readonly unitOfWork: UnitOfWork<WalletRepositories>) {}

  /**
   * @param query - The wallet, the cursor and the page size.
   * @returns The entries and the cursor of the next page.
   * @throws {@link WalletNotFoundError} If the wallet id is malformed or unknown.
   * @throws {@link InvalidCursorError} If the cursor is malformed or of another wallet.
   */
  async execute(query: GetLedgerPageQuery): Promise<LedgerPage> {
    const { walletId, limit } = query;
    if (!isWalletIdFormat(walletId)) throw new WalletNotFoundError(walletId);
    const afterVersion = query.cursor === undefined ? 0 : decodeLedgerCursor(query.cursor, walletId);

    const items = await this.unitOfWork.run(async ({ wallets, ledger }) => {
      const wallet = await wallets.findById(walletId);
      if (!wallet) throw new WalletNotFoundError(walletId);
      return ledger.findPage(wallet.id, afterVersion, limit);
    });
    const last = items.at(-1);
    const nextCursor = items.length === limit && last ? encodeLedgerCursor(walletId, last.walletVersion) : null;
    return { items, nextCursor };
  }
}
