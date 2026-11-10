/**
 * Looks a wallet up by id.
 *
 * @packageDocumentation
 */
import type { UnitOfWork } from '../../shared/application/unit-of-work.ts';
import type { Wallet } from '../domain/wallet.ts';
import type { WalletRepositories } from './wallet-repository.ts';
import { WalletNotFoundError } from './wallet-errors.ts';

// Wallet ids are UUIDs; anything else cannot exist and never reaches the database.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class GetWallet {
  constructor(private readonly unitOfWork: UnitOfWork<WalletRepositories>) {}

  /**
   * @param walletId - The wallet id.
   * @returns The wallet.
   * @throws {@link WalletNotFoundError} If the id is malformed or unknown.
   */
  async execute(walletId: string): Promise<Wallet> {
    if (!UUID_PATTERN.test(walletId)) throw new WalletNotFoundError(walletId);
    const wallet = await this.unitOfWork.run(({ wallets }) => wallets.findById(walletId));
    if (!wallet) throw new WalletNotFoundError(walletId);
    return wallet;
  }
}
