/**
 * `WalletLedgerEntry` mapping, kept out of the domain. `money` takes the bare
 * `amount` and `currency` columns — the same `currency` the composite foreign
 * key pins to the wallet's. `transactionId` is a plain column, not a relation.
 *
 * @packageDocumentation
 */
import { defineEntity, p, type EntityCtor } from '@mikro-orm/core';
import { MoneySchema } from '../../shared/infrastructure/money.schema.ts';
import { LedgerDirection, WalletLedgerEntry } from '../domain/wallet-ledger-entry.ts';
import { WalletSchema } from './wallet.schema.ts';

// Type-only cast for the private constructor; see `money.schema.ts`.
const WalletLedgerEntryClass = WalletLedgerEntry as unknown as EntityCtor<WalletLedgerEntry>;

export const WalletLedgerEntrySchema = defineEntity({
  class: WalletLedgerEntryClass,
  tableName: 'wallet_ledger_entries',
  properties: {
    id: p.uuid().primary(),
    // The wallet as a relation mapped to its key: the domain keeps a plain id,
    // and the flush still inserts the wallet before the entry.
    walletId: p.manyToOne(WalletSchema).mapToPk().fieldName('wallet_id'),
    // The transaction as a plain column, so `wallet` does not depend on the
    // mapping of `wagering`: its foreign keys, checked at commit, still require
    // it (migration 0014).
    transactionId: p.uuid().fieldName('transaction_id'),
    direction: p.enum(() => LedgerDirection),
    money: p.embedded(MoneySchema).prefix(false),
    balanceBefore: p.embedded(MoneySchema).prefix('balance_before_'),
    balanceAfter: p.embedded(MoneySchema).prefix('balance_after_'),
    walletVersion: p.integer(),
    createdAt: p.datetime(),
  },
});
