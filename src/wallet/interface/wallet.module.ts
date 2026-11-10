/**
 * Nest module of the wallet: its controller and use cases, wired to the unit
 * of work by token so the use cases stay free of NestJS.
 *
 * @packageDocumentation
 */
import { Module } from '@nestjs/common';
import { UNIT_OF_WORK, type UnitOfWork } from '../../shared/application/unit-of-work.ts';
import { CreateWallet } from '../application/create-wallet.ts';
import { GetWallet } from '../application/get-wallet.ts';
import type { WalletRepositories } from '../application/wallet-repository.ts';
import { WalletController } from './wallet.controller.ts';

@Module({
  controllers: [WalletController],
  providers: [
    {
      provide: CreateWallet,
      inject: [UNIT_OF_WORK],
      useFactory: (unitOfWork: UnitOfWork<WalletRepositories>) =>
        new CreateWallet(unitOfWork, () => Bun.randomUUIDv7()),
    },
    {
      provide: GetWallet,
      inject: [UNIT_OF_WORK],
      useFactory: (unitOfWork: UnitOfWork<WalletRepositories>) => new GetWallet(unitOfWork),
    },
  ],
})
export class WalletModule {}
