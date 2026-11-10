/**
 * `UnitOfWork` over MikroORM: each run gets its own forked entity manager (its
 * own identity map) inside one SQL transaction, and repositories bound to it.
 *
 * @packageDocumentation
 */
import type { EntityManager } from '@mikro-orm/postgresql';
import type { UnitOfWork } from '../shared/application/unit-of-work.ts';
import type { WalletRepositories } from '../wallet/application/wallet-repository.ts';
import { MikroOrmWalletRepository } from '../wallet/infrastructure/mikro-orm-wallet.repository.ts';
import { translateDatabaseError } from './translate-database-error.ts';

/** Every repository a unit of work offers; use cases ask for a subset. */
export type Repositories = WalletRepositories;

export class MikroOrmUnitOfWork implements UnitOfWork<Repositories> {
  constructor(private readonly em: EntityManager) {}

  async run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    try {
      return await this.em
        .fork()
        .transactional((tx) => work({ wallets: new MikroOrmWalletRepository(tx) }));
    } catch (error) {
      throw translateDatabaseError(error);
    }
  }
}
