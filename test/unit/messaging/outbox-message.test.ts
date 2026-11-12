/**
 * Unit tests for `OutboxMessage` (§6.5): enqueueing an integration event, when
 * it is due, publishing it and rescheduling it with backoff.
 *
 * @packageDocumentation
 */
import { describe, expect, test } from 'bun:test';
import { OutboxMessage } from '../../../src/messaging/domain/outbox-message.ts';
import { Money } from '../../../src/shared/domain/money.ts';
import { WalletBalanceChanged } from '../../../src/wallet/domain/wallet-balance-changed.ts';
import { Wallet } from '../../../src/wallet/domain/wallet.ts';

const WALLET_ID = '0192f291-27dd-7d3f-8071-5f8685deef37';
const EVENT_ID = '0192f291-27dd-7d3f-8071-5f8685deef39';
const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
const NOW = new Date('2026-11-10T12:00:00.000Z');
const later = (ms: number): Date => new Date(NOW.getTime() + ms);

function balanceChanged(): WalletBalanceChanged {
  const wallet = Wallet.open({ id: WALLET_ID, playerId: 'player-1', initialBalance: brl('100.00') });
  const entry = wallet.debit({ money: brl('25.00'), entryId: 'entry-1', transactionId: 'tx-1' });
  return WalletBalanceChanged.from(wallet, entry, { correlationId: 'corr-1', causationId: 'tx-1' }, { eventId: EVENT_ID });
}

const pending = (overrides: Partial<Parameters<typeof OutboxMessage.rehydrate>[0]> = {}): OutboxMessage =>
  OutboxMessage.rehydrate({
    id: EVENT_ID,
    aggregateId: WALLET_ID,
    eventType: 'WalletBalanceChanged',
    walletId: WALLET_ID,
    payload: {},
    occurredAt: NOW,
    attempts: 0,
    ...overrides,
  });

describe('OutboxMessage.enqueue', () => {
  test('takes the event id as its id, the envelope as payload and the wallet as group', () => {
    const event = balanceChanged();

    const message = OutboxMessage.enqueue(event);

    expect(message.id).toBe(EVENT_ID);
    expect(message.aggregateId).toBe(WALLET_ID);
    expect(message.eventType).toBe('WalletBalanceChanged');
    expect(message.walletId).toBe(WALLET_ID);
    expect(message.payload).toEqual(JSON.parse(JSON.stringify(event.toJSON())));
    expect(message.occurredAt).toEqual(event.occurredAt);
    expect(message.attempts).toBe(0);
    expect(message.nextAttemptAt).toBeUndefined();
    expect(message.publishedAt).toBeUndefined();
    expect(message.isPending()).toBe(true);
  });
});

describe('OutboxMessage.isDue', () => {
  test('a new message is due at once', () => {
    expect(OutboxMessage.enqueue(balanceChanged()).isDue(NOW)).toBe(true);
  });

  test('a message scheduled later is not due before its time', () => {
    const message = pending({ nextAttemptAt: later(1000) });

    expect(message.isDue(NOW)).toBe(false);
    expect(message.isDue(later(1000))).toBe(true);
  });

  test('a published message is never due', () => {
    const message = pending();
    message.markPublished(NOW);

    expect(message.isPending()).toBe(false);
    expect(message.publishedAt).toEqual(NOW);
    expect(message.isDue(later(60_000))).toBe(false);
  });
});

describe('OutboxMessage.scheduleRetry', () => {
  const noJitter = { baseMs: 1000, maxMs: 300_000, random: () => 0.5 };

  test('counts the attempt and waits 1 s × 2^attempts', () => {
    const message = pending({ attempts: 3 });

    message.scheduleRetry(NOW, noJitter);

    expect(message.attempts).toBe(4);
    expect(message.nextAttemptAt).toEqual(later(8000));
  });

  test('never waits more than the cap, however many attempts', () => {
    const message = pending({ attempts: 40 });

    message.scheduleRetry(NOW, noJitter);

    expect(message.attempts).toBe(41);
    expect(message.nextAttemptAt).toEqual(later(300_000));
  });

  test.each([
    [0, 800],
    [0.999_999, 1200],
  ])('jitters the delay by ±20%% (random %p)', (random, expectedMs) => {
    const message = pending();

    message.scheduleRetry(NOW, { ...noJitter, random: () => random });

    expect(Math.abs(message.nextAttemptAt!.getTime() - later(expectedMs).getTime())).toBeLessThanOrEqual(1);
  });

  test('has no limit of attempts and defaults to 1 s up to 5 min', () => {
    const message = pending({ attempts: 1000 });

    message.scheduleRetry(NOW);

    expect(message.isPending()).toBe(true);
    const delay = message.nextAttemptAt!.getTime() - NOW.getTime();
    expect(delay).toBeGreaterThanOrEqual(240_000);
    expect(delay).toBeLessThanOrEqual(360_000);
  });
});
