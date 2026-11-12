/**
 * Unit tests for `WalletBalanceChanged`: the `data` of §11, built from a wallet
 * and the ledger entry that changed its balance.
 *
 * @packageDocumentation
 */
import { describe, expect, test } from 'bun:test';
import { Money } from '../../../src/shared/domain/money.ts';
import { WalletBalanceChanged } from '../../../src/wallet/domain/wallet-balance-changed.ts';
import { Wallet } from '../../../src/wallet/domain/wallet.ts';

const WALLET_ID = '0192f291-27dd-7d3f-8071-5f8685deef37';
const TRANSACTION_ID = '0192f291-27dd-7d3f-8071-5f8685deef38';
const EVENT_ID = '0192f291-27dd-7d3f-8071-5f8685deef39';
// What the outbox stores: the envelope as JSON.
const asJson = (event: object): unknown => JSON.parse(JSON.stringify(event));
const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

describe('WalletBalanceChanged', () => {
  test('carries the movement and the balances around it, aggregated by the wallet id', () => {
    const wallet = Wallet.open({ id: WALLET_ID, playerId: 'player-1', initialBalance: brl('100.00') });
    const entry = wallet.debit({ money: brl('25.00'), entryId: 'entry-1', transactionId: TRANSACTION_ID });

    const event = WalletBalanceChanged.from(
      wallet,
      entry,
      { correlationId: 'corr-1', causationId: TRANSACTION_ID },
      { eventId: EVENT_ID },
    );

    expect(asJson(event)).toEqual({
      eventId: EVENT_ID,
      eventType: 'WalletBalanceChanged',
      aggregateId: WALLET_ID,
      correlationId: 'corr-1',
      causationId: TRANSACTION_ID,
      occurredAt: entry.createdAt.toISOString(),
      version: 1,
      data: {
        walletId: WALLET_ID,
        transactionId: TRANSACTION_ID,
        direction: 'DEBIT',
        money: { amount: '25.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '75.00', currency: 'BRL' },
        walletVersion: 2,
      },
    });
  });

  test('refuses an entry of another wallet', () => {
    const wallet = Wallet.open({ id: WALLET_ID, playerId: 'player-1', initialBalance: brl('100.00') });
    const other = Wallet.open({ id: TRANSACTION_ID, playerId: 'player-2', initialBalance: brl('100.00') });
    const entry = other.debit({ money: brl('1.00'), entryId: 'entry-1', transactionId: 'tx' });

    expect(() => WalletBalanceChanged.from(wallet, entry, { correlationId: 'c' }, { eventId: EVENT_ID })).toThrow();
  });
});
