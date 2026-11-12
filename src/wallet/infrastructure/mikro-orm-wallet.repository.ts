/**
 * `WalletRepository` over a MikroORM entity manager bound to one transaction.
 *
 * @packageDocumentation
 */
import { LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { Wallet } from '../domain/wallet.ts';
import type { WalletRepository } from '../application/wallet-repository.ts';

// How long a unit of work waits for a wallet locked by another (ADR 0002). Set
// per SQL transaction, never on the connection: it covers every lock wait after
// the wallet's, which is always the first lock taken.
const LOCK_TIMEOUT = '2s';

export class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  findById(id: string): Promise<Wallet | null> {
    return this.em.findOne(Wallet, { id });
  }

  async findByIdForUpdate(id: string): Promise<Wallet | null> {
    await this.em.execute(`set local lock_timeout = '${LOCK_TIMEOUT}'`);
    return this.em.findOne(Wallet, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
  }

  findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null> {
    return this.em.findOne(Wallet, { playerId, currency });
  }

  findByCreationIdempotencyKey(idempotencyKey: string): Promise<Wallet | null> {
    return this.em.findOne(Wallet, { creationIdempotencyKey: idempotencyKey });
  }

  add(wallet: Wallet): void {
    this.em.persist(wallet);
  }
}
