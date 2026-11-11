/**
 * Unit tests for the integration events of a wager transaction's outcome: the
 * envelope of §11 and the `data` of the contracts table in `ARCHITECTURE.md`
 * § Eventos de integração.
 *
 * @packageDocumentation
 */
import { describe, expect, test } from 'bun:test';
import { FailureCode } from '../../../src/shared/domain/failure-code.ts';
import { Money } from '../../../src/shared/domain/money.ts';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from '../../../src/wagering/domain/wager-transaction-events.ts';
import { WagerTransaction, WagerTransactionKind } from '../../../src/wagering/domain/wager-transaction.ts';

const WALLET_ID = '0192f291-27dd-7d3f-8071-5f8685deef37';
const TRANSACTION_ID = '0192f291-27dd-7d3f-8071-5f8685deef38';
const EVENT_ID = '0192f291-27dd-7d3f-8071-5f8685deef39';
// What the outbox stores: the envelope as JSON.
const asJson = (event: object): unknown => JSON.parse(JSON.stringify(event));
const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
const context = { correlationId: 'corr-1', causationId: TRANSACTION_ID };

function bet(): WagerTransaction {
  return WagerTransaction.create({
    id: TRANSACTION_ID,
    providerId: 'provider-a',
    externalTransactionId: 'bet-1',
    idempotencyKey: 'key-1',
    payloadHash: 'a'.repeat(64),
    walletId: WALLET_ID,
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: brl('25.00'),
    correlationId: 'corr-1',
  });
}

describe('WagerTransactionProcessed', () => {
  test('carries the transaction and its outcome, aggregated by the transaction id', () => {
    const transaction = bet();
    const at = new Date('2026-11-10T12:00:00.000Z');
    transaction.markProcessed({ at, balanceAfter: brl('75.00'), walletVersionObserved: 2 });

    const event = WagerTransactionProcessed.from(transaction, context, { eventId: EVENT_ID });

    expect(asJson(event)).toEqual({
      eventId: EVENT_ID,
      eventType: 'WagerTransactionProcessed',
      aggregateId: TRANSACTION_ID,
      correlationId: 'corr-1',
      causationId: TRANSACTION_ID,
      occurredAt: '2026-11-10T12:00:00.000Z',
      version: 1,
      data: {
        transactionId: TRANSACTION_ID,
        providerId: 'provider-a',
        externalTransactionId: 'bet-1',
        walletId: WALLET_ID,
        playerId: 'player-1',
        roundId: 'round-1',
        gameId: 'game-1',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
        balanceAfter: { amount: '75.00', currency: 'BRL' },
        walletVersion: 2,
        processedAt: '2026-11-10T12:00:00.000Z',
      },
    });
  });

  test('carries plain money props, never a Money instance', () => {
    const transaction = bet();
    transaction.markProcessed({ at: new Date(), balanceAfter: brl('75.00'), walletVersionObserved: 2 });

    const event = WagerTransactionProcessed.from(transaction, context, { eventId: EVENT_ID });

    expect(event.data.money).not.toBeInstanceOf(Money);
    expect(event.data.balanceAfter).not.toBeInstanceOf(Money);
  });

  test('refuses a transaction that was not processed', () => {
    expect(() => WagerTransactionProcessed.from(bet(), context, { eventId: EVENT_ID })).toThrow();
  });
});

describe('WagerTransactionRejected', () => {
  test('carries the failure code, the balance observed and when it was rejected', () => {
    const transaction = bet();
    transaction.reject({ code: FailureCode.InsufficientFunds, balanceAfter: brl('10.00'), walletVersionObserved: 3 });
    const at = new Date('2026-11-10T12:00:01.000Z');

    const event = WagerTransactionRejected.from(transaction, context, { eventId: EVENT_ID, at });

    expect(asJson(event)).toEqual({
      eventId: EVENT_ID,
      eventType: 'WagerTransactionRejected',
      aggregateId: TRANSACTION_ID,
      correlationId: 'corr-1',
      causationId: TRANSACTION_ID,
      occurredAt: '2026-11-10T12:00:01.000Z',
      version: 1,
      data: {
        transactionId: TRANSACTION_ID,
        providerId: 'provider-a',
        externalTransactionId: 'bet-1',
        walletId: WALLET_ID,
        playerId: 'player-1',
        roundId: 'round-1',
        gameId: 'game-1',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
        failureCode: 'INSUFFICIENT_FUNDS',
        balanceAfter: { amount: '10.00', currency: 'BRL' },
        walletVersion: 3,
        rejectedAt: '2026-11-10T12:00:01.000Z',
      },
    });
  });

  test('refuses a transaction that was not rejected', () => {
    expect(() => WagerTransactionRejected.from(bet(), context, { eventId: EVENT_ID, at: new Date() })).toThrow();
  });
});

describe('WagerTransactionPendingReference', () => {
  const pendingWin = (): WagerTransaction => {
    const transaction = WagerTransaction.create({
      id: TRANSACTION_ID,
      providerId: 'provider-a',
      externalTransactionId: 'win-1',
      idempotencyKey: 'key-1',
      payloadHash: 'a'.repeat(64),
      walletId: WALLET_ID,
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Win,
      money: brl('40.00'),
      referenceExternalTransactionId: 'bet-1',
      correlationId: 'corr-1',
    });
    transaction.markPendingReference();
    return transaction;
  };

  test('occurs at the creation and expires at creation + TTL', () => {
    const transaction = pendingWin();

    const event = WagerTransactionPendingReference.from(transaction, context, { eventId: EVENT_ID, ttlMs: 300_000 });

    const json = asJson(event) as { occurredAt: string; data: Record<string, unknown> };
    expect(json).toMatchObject({ eventType: 'WagerTransactionPendingReference', version: 1, aggregateId: TRANSACTION_ID });
    expect(json.occurredAt).toBe(transaction.createdAt.toISOString());
    expect(json.data).toEqual({
      transactionId: TRANSACTION_ID,
      providerId: 'provider-a',
      externalTransactionId: 'win-1',
      walletId: WALLET_ID,
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'WIN',
      money: { amount: '40.00', currency: 'BRL' },
      referenceExternalTransactionId: 'bet-1',
      expiresAt: new Date(transaction.createdAt.getTime() + 300_000).toISOString(),
    });
  });

  test('refuses a transaction that is not waiting for its reference', () => {
    expect(() => WagerTransactionPendingReference.from(bet(), context, { eventId: EVENT_ID, ttlMs: 1 })).toThrow();
  });
});
