/**
 * `UnitOfWork` over MikroORM: each run gets its own forked entity manager (its
 * own identity map) inside one SQL transaction, and repositories bound to it.
 *
 * @packageDocumentation
 */
import type { EntityManager } from '@mikro-orm/postgresql';
import type { FaultInjection, FaultPoint } from '../shared/application/fault-injector.ts';
import type { UnitOfWork } from '../shared/application/unit-of-work.ts';
import type { WageringRepositories } from '../wagering/application/wager-transaction-repository.ts';
import { MikroOrmWagerTransactionRepository } from '../wagering/infrastructure/mikro-orm-wager-transaction.repository.ts';
import type { WalletRepositories } from '../wallet/application/wallet-repository.ts';
import { MikroOrmWalletLedgerRepository } from '../wallet/infrastructure/mikro-orm-wallet-ledger.repository.ts';
import { MikroOrmWalletRepository } from '../wallet/infrastructure/mikro-orm-wallet.repository.ts';
import { SqlFaultInjector } from './sql-fault-injector.ts';
import { translateDatabaseError } from './translate-database-error.ts';

/** Every repository a unit of work offers, and its fault injector; use cases ask for a subset. */
export type Repositories = WalletRepositories & WageringRepositories & FaultInjection;

export class MikroOrmUnitOfWork implements UnitOfWork<Repositories> {
  private readonly faultPoints: ReadonlySet<FaultPoint>;

  /**
   * @param em - The global entity manager; each run forks its own.
   * @param faultPoints - The fault points enabled; none by default.
   */
  constructor(
    private readonly em: EntityManager,
    faultPoints: readonly FaultPoint[] = [],
  ) {
    this.faultPoints = new Set(faultPoints);
  }

  async run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    try {
      return await this.em.fork().transactional((tx) =>
        work({
          wallets: new MikroOrmWalletRepository(tx),
          ledger: new MikroOrmWalletLedgerRepository(tx),
          transactions: new MikroOrmWagerTransactionRepository(tx),
          faults: new SqlFaultInjector(tx, this.faultPoints),
        }),
      );
    } catch (error) {
      throw translateDatabaseError(error);
    }
  }
}
