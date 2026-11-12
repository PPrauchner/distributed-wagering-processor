/**
 * `WagerTransaction` mapping, kept out of the domain. Private fields point at
 * their public getters (`accessor`); `money` takes the bare `amount` and
 * `currency` columns.
 *
 * @packageDocumentation
 */
import { defineEntity, p, type EntityCtor } from '@mikro-orm/core';
import { MoneySchema } from '../../shared/infrastructure/money.schema.ts';
import { WalletSchema } from '../../wallet/infrastructure/wallet.schema.ts';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/wager-transaction.ts';

// Type-only cast for the private constructor; see `money.schema.ts`.
const WagerTransactionClass = WagerTransaction as unknown as EntityCtor<WagerTransaction>;

export const WagerTransactionSchema = defineEntity({
  class: WagerTransactionClass,
  tableName: 'wager_transactions',
  properties: {
    id: p.uuid().primary(),
    providerId: p.string().length(255),
    externalTransactionId: p.string().length(255),
    idempotencyKey: p.string().length(255),
    payloadHash: p.string().length(64),
    // A relation mapped to its key: the domain keeps the plain id, and the flush
    // still inserts the wallet before its transactions.
    walletId: p.manyToOne(WalletSchema).mapToPk().fieldName('wallet_id'),
    playerId: p.string().length(255),
    roundId: p.string().length(255),
    gameId: p.string().length(255),
    kind: p.enum(() => WagerTransactionKind),
    money: p.embedded(MoneySchema).prefix(false),
    referenceExternalTransactionId: p.string().length(255).nullable(),
    correlationId: p.text(),
    createdAt: p.datetime(),
    _status: p.enum(() => WagerTransactionStatus).accessor('status'),
    _referenceTransactionId: p.uuid().nullable().accessor('referenceTransactionId'),
    _failureCode: p.text().nullable().accessor('failureCode'),
    _processedAt: p.datetime().nullable().accessor('processedAt'),
    _balanceAfter: p.embedded(MoneySchema).prefix('balance_after_').nullable().accessor('balanceAfter'),
    _walletVersionObserved: p.integer().nullable().accessor('walletVersionObserved'),
    _failureMessage: p.text().nullable().accessor('failureMessage'),
    _attempts: p.integer().accessor('attempts'),
    _nextAttemptAt: p.datetime().nullable().accessor('nextAttemptAt'),
  },
});
