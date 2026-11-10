/**
 * Unit tests for the `Wallet` aggregate: opening and rehydration.
 *
 * @packageDocumentation
 */
import { describe, expect, test } from 'bun:test';
import { Money } from '../../../src/shared/domain/money.ts';
import { InvalidWalletError, Wallet } from '../../../src/wallet/domain/wallet.ts';

const WALLET_ID = '0192f291-27dd-7d3f-8071-5f8685deef37';
const PLAYER_ID = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';

describe('Wallet.open', () => {
  test('opens with a zero balance at version 1 in the balance currency', () => {
    const wallet = Wallet.open({
      id: WALLET_ID,
      playerId: PLAYER_ID,
      initialBalance: Money.zero('BRL'),
    });

    expect(wallet.id).toBe(WALLET_ID);
    expect(wallet.playerId).toBe(PLAYER_ID);
    expect(wallet.currency).toBe('BRL');
    expect(wallet.balance.equals(Money.zero('BRL'))).toBe(true);
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toEqual(wallet.createdAt);
  });

  test('refuses a negative initial balance', () => {
    const negative = Money.zero('BRL').subtract(Money.from({ amount: '0.01', currency: 'BRL' }));

    expect(() =>
      Wallet.open({ id: WALLET_ID, playerId: PLAYER_ID, initialBalance: negative }),
    ).toThrow(InvalidWalletError);
  });

  test.each([[''], ['x'.repeat(256)]])('refuses the player id %p', (playerId) => {
    expect(() =>
      Wallet.open({ id: WALLET_ID, playerId, initialBalance: Money.zero('BRL') }),
    ).toThrow(InvalidWalletError);
  });

  test('accepts a non-UUID player id up to 255 characters', () => {
    const playerId = 'p'.repeat(255);

    const wallet = Wallet.open({ id: WALLET_ID, playerId, initialBalance: Money.zero('BRL') });

    expect(wallet.playerId).toBe(playerId);
  });
});

describe('Wallet.rehydrate', () => {
  test('rebuilds persisted state as is, without re-running opening rules', () => {
    const createdAt = new Date('2026-11-01T10:00:00Z');
    const updatedAt = new Date('2026-11-02T10:00:00Z');
    const balance = Money.from({ amount: '150.25', currency: 'USD' });

    const wallet = Wallet.rehydrate({
      id: WALLET_ID,
      playerId: PLAYER_ID,
      currency: 'USD',
      balance,
      version: 7,
      createdAt,
      updatedAt,
    });

    expect(wallet.balance.equals(balance)).toBe(true);
    expect(wallet.currency).toBe('USD');
    expect(wallet.version).toBe(7);
    expect(wallet.createdAt).toEqual(createdAt);
    expect(wallet.updatedAt).toEqual(updatedAt);
  });
});
