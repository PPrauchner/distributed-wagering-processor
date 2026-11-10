/**
 * `WalletRepository` over a MikroORM entity manager bound to one transaction.
 *
 * @packageDocumentation
 */
import { LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { Wallet } from '../domain/wallet.ts';
import type { WalletRepository } from '../application/wallet-repository.ts';

export class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  findById(id: string): Promise<Wallet | null> {
    return this.em.findOne(Wallet, { id });
  }

  findByIdForUpdate(id: string): Promise<Wallet | null> {
    return this.em.findOne(Wallet, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
  }

  findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null> {
    return this.em.findOne(Wallet, { playerId, currency });
  }

  add(wallet: Wallet): void {
    this.em.persist(wallet);
  }
}
