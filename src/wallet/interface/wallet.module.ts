/**
 * Nest module of the wallet: its controller and use cases, wired to the unit
 * of work, the log, the metrics — bound by the health module — and the
 * recorder of the opening — given by the composition root — by token so the
 * use cases stay free of NestJS.
 *
 * @packageDocumentation
 */
import { Module, type DynamicModule } from '@nestjs/common';
import type { OutboxRepositories } from '../../messaging/application/outbox-repository.ts';
import { CONTEXT_LOG, type ContextLog } from '../../shared/application/context-log.ts';
import { UNIT_OF_WORK, type UnitOfWork } from '../../shared/application/unit-of-work.ts';
import { CreateWallet } from '../application/create-wallet.ts';
import { GetLedgerPage } from '../application/get-ledger-page.ts';
import { GetWallet } from '../application/get-wallet.ts';
import { OPENING_RECORDER, type OpeningRecorder } from '../application/opening-recorder.ts';
import {
  RECONCILIATION_DIVERGENCE_COUNTER,
  Reconciliation,
  type ReconciliationDivergenceCounter,
} from '../application/reconciliation.ts';
import { WALLET_METRICS, type WalletMetrics } from '../application/wallet-metrics.ts';
import type { WalletRepositories } from '../application/wallet-repository.ts';
import { WalletController } from './wallet.controller.ts';

/** What the wallet module needs from outside it. */
export interface WalletModuleOptions<TOpeningRepositories> {
  /** Records the opening of a wallet created with a positive balance. */
  openingRecorder: OpeningRecorder<TOpeningRepositories>;
}

@Module({})
export class WalletModule {
  /**
   * @param options - The recorder of the opening.
   * @returns The module, with its controller.
   */
  static forRoot<TOpeningRepositories>(options: WalletModuleOptions<TOpeningRepositories>): DynamicModule {
    return {
      module: WalletModule,
      controllers: [WalletController],
      providers: [
        { provide: OPENING_RECORDER, useValue: options.openingRecorder },
        {
          provide: CreateWallet,
          inject: [UNIT_OF_WORK, OPENING_RECORDER, WALLET_METRICS],
          useFactory: (
            unitOfWork: UnitOfWork<WalletRepositories & OutboxRepositories & TOpeningRepositories>,
            openings: OpeningRecorder<TOpeningRepositories>,
            metrics: WalletMetrics,
          ) => new CreateWallet(unitOfWork, openings, () => Bun.randomUUIDv7(), metrics),
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
          inject: [UNIT_OF_WORK, RECONCILIATION_DIVERGENCE_COUNTER, CONTEXT_LOG],
          useFactory: (
            unitOfWork: UnitOfWork<WalletRepositories>,
            divergences: ReconciliationDivergenceCounter,
            log: ContextLog,
          ) => new Reconciliation(unitOfWork, divergences, log),
        },
      ],
    };
  }
}
