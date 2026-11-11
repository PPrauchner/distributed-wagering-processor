/**
 * Nest module of the wallet: its controller and use cases, wired to the unit
 * of work and the divergence counter — bound by the metrics — by token so the
 * use cases stay free of NestJS.
 *
 * @packageDocumentation
 */
import { Logger, Module } from '@nestjs/common';
import type { OutboxRepositories } from '../../messaging/application/outbox-repository.ts';
import { UNIT_OF_WORK, type UnitOfWork } from '../../shared/application/unit-of-work.ts';
import { CreateWallet } from '../application/create-wallet.ts';
import { GetLedgerPage } from '../application/get-ledger-page.ts';
import { GetWallet } from '../application/get-wallet.ts';
import {
  RECONCILIATION_DIVERGENCE_COUNTER,
  Reconciliation,
  type ReconciliationDivergenceCounter,
} from '../application/reconciliation.ts';
import type { WageringRepositories } from '../../wagering/application/wager-transaction-repository.ts';
import type { WalletRepositories } from '../application/wallet-repository.ts';
import { WalletController } from './wallet.controller.ts';

@Module({
  controllers: [WalletController],
  providers: [
    {
      provide: CreateWallet,
      inject: [UNIT_OF_WORK],
      useFactory: (unitOfWork: UnitOfWork<WalletRepositories & WageringRepositories & OutboxRepositories>) =>
        new CreateWallet(unitOfWork, () => Bun.randomUUIDv7()),
    },
    {
      provide: GetWallet,
      inject: [UNIT_OF_WORK],
      useFactory: (unitOfWork: UnitOfWork<WalletRepositories>) => new GetWallet(unitOfWork),
    },
    {
      provide: GetLedgerPage,
      inject: [UNIT_OF_WORK],
      useFactory: (unitOfWork: UnitOfWork<WalletRepositories>) => new GetLedgerPage(unitOfWork),
    },
    {
      provide: Reconciliation,
      inject: [UNIT_OF_WORK, RECONCILIATION_DIVERGENCE_COUNTER],
      useFactory: (unitOfWork: UnitOfWork<WalletRepositories>, divergences: ReconciliationDivergenceCounter) =>
        new Reconciliation(unitOfWork, divergences, new Logger('Reconciliation')),
    },
  ],
})
export class WalletModule {}
