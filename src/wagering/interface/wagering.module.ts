/**
 * Nest module of wagering: its controller and use case, wired to the unit of
 * work by token so the use case stays free of NestJS.
 *
 * @packageDocumentation
 */
import { Module } from '@nestjs/common';
import { UNIT_OF_WORK, type UnitOfWork } from '../../shared/application/unit-of-work.ts';
import type { WalletRepositories } from '../../wallet/application/wallet-repository.ts';
import { ProcessWagerTransaction } from '../application/process-wager-transaction.ts';
import type { WageringRepositories } from '../application/wager-transaction-repository.ts';
import { WagerTransactionController } from './wager-transaction.controller.ts';

@Module({
  controllers: [WagerTransactionController],
  providers: [
    {
      provide: ProcessWagerTransaction,
      inject: [UNIT_OF_WORK],
      useFactory: (unitOfWork: UnitOfWork<WalletRepositories & WageringRepositories>) =>
        new ProcessWagerTransaction(unitOfWork, () => Bun.randomUUIDv7()),
    },
  ],
})
export class WageringModule {}
