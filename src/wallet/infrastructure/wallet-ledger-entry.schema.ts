/**
 * `WalletLedgerEntry` mapping, kept out of the domain. `money` takes the bare
 * `amount` and `currency` columns — the same `currency` the composite foreign
 * key pins to the wallet's.
 *
 * @packageDocumentation
 */
import { defineEntity, p, type EntityCtor } from '@mikro-orm/core';
import { MoneySchema } from '../../shared/infrastructure/money.schema.ts';
import { WagerTransactionSchema } from '../../wagering/infrastructure/wager-transaction.schema.ts';
import { LedgerDirection, WalletLedgerEntry } from '../domain/wallet-ledger-entry.ts';
import { WalletSchema } from './wallet.schema.ts';

// Type-only cast for the private constructor; see `money.schema.ts`.
const WalletLedgerEntryClass = WalletLedgerEntry as unknown as EntityCtor<WalletLedgerEntry>;

export const WalletLedgerEntrySchema = defineEntity({
  class: WalletLedgerEntryClass,
  tableName: 'wallet_ledger_entries',
  properties: {
    id: p.uuid().primary(),
    // Relations mapped to their keys: the domain keeps plain ids, and the flush
    // still inserts the wallet and the transaction before the entry.
    walletId: p.manyToOne(WalletSchema).mapToPk().fieldName('wallet_id'),
    transactionId: p.manyToOne(WagerTransactionSchema).mapToPk().fieldName('transaction_id'),
    direction: p.enum(() => LedgerDirection),
    money: p.embedded(MoneySchema).prefix(false),
    balanceBefore: p.embedded(MoneySchema).prefix('balance_before_'),
    balanceAfter: p.embedded(MoneySchema).prefix('balance_after_'),
    walletVersion: p.integer(),
    createdAt: p.datetime(),
  },
});
