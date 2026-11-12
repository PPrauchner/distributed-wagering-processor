/**
 * `Wallet` mapping, kept out of the domain. Private fields point at their public
 * getters (`accessor`), so queries use the domain name with types.
 *
 * @packageDocumentation
 */
import { defineEntity, p, type EntityCtor } from '@mikro-orm/core';
import { MoneySchema } from '../../shared/infrastructure/money.schema.ts';
import { Wallet } from '../domain/wallet.ts';

// Type-only cast for the private constructor; see `money.schema.ts`.
const WalletClass = Wallet as unknown as EntityCtor<Wallet>;

export const WalletSchema = defineEntity({
  class: WalletClass,
  tableName: 'wallets',
  properties: {
    id: p.uuid().primary(),
    playerId: p.string().length(255),
    currency: p.string().length(3),
    _balance: p.embedded(MoneySchema).prefix('balance_').accessor('balance'),
    _version: p.integer().accessor('version'),
    createdAt: p.datetime(),
    _updatedAt: p.datetime().accessor('updatedAt'),
    initialBalance: p.embedded(MoneySchema).prefix('initial_balance_'),
    creationIdempotencyKey: p.string().length(255).nullable(),
    creationPayloadHash: p.string().length(64).nullable(),
  },
});
