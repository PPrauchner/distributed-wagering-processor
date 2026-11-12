/**
 * Looks a wallet up by id.
 *
 * @packageDocumentation
 */
import type { UnitOfWork } from '../../shared/application/unit-of-work.ts';
import type { Wallet } from '../domain/wallet.ts';
import type { WalletRepositories } from './wallet-repository.ts';
import { WalletNotFoundError } from './wallet-errors.ts';
import { isWalletIdFormat } from './wallet-id.ts';

export class GetWallet {
  constructor(private readonly unitOfWork: UnitOfWork<WalletRepositories>) {}

  /**
   * @param walletId - The wallet id.
   * @returns The wallet.
   * @throws {@link WalletNotFoundError} If the id is malformed or unknown.
   */
  async execute(walletId: string): Promise<Wallet> {
    if (!isWalletIdFormat(walletId)) throw new WalletNotFoundError(walletId);
    const wallet = await this.unitOfWork.run(({ wallets }) => wallets.findById(walletId));
    if (!wallet) throw new WalletNotFoundError(walletId);
    return wallet;
  }
}
