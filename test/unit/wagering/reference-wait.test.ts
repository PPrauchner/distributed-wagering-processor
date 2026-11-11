/**
 * Unit tests for the wait of a transaction pending its reference: the backoff
 * of its next attempt — `min(base × 2^attempts, max)`, ±20% jitter — and the
 * transitions it goes through while it waits (`ARCHITECTURE.md` § Referências
 * fora de ordem; § Transições da transação de aposta).
 *
 * @packageDocumentation
 */
import { describe, expect, test } from 'bun:test';
import { FailureCode } from '../../../src/shared/domain/failure-code.ts';
import { Money } from '../../../src/shared/domain/money.ts';
import { waitForReference } from '../../../src/wagering/domain/reference.ts';
import { referenceRetryDelayMs } from '../../../src/wagering/domain/reference-wait.ts';
import {
  InvalidTransactionStateError,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../src/wagering/domain/wager-transaction.ts';

const NOW = new Date('2026-11-10T10:00:00Z');
const later = (ms: number): Date => new Date(NOW.getTime() + ms);
const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
const noJitter = { baseMs: 1000, maxMs: 60_000, random: () => 0.5 };

const refund = (): WagerTransaction =>
  WagerTransaction.create({
    id: '0192f298-345e-7e38-af88-e43f851a819d',
    providerId: 'provider-a',
    externalTransactionId: 'refund-1',
    idempotencyKey: 'key-1',
    payloadHash: 'a'.repeat(64),
    walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
    playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Refund,
    money: brl('20.00'),
    referenceExternalTransactionId: 'bet-1',
    correlationId: 'corr-1',
  });

const pending = (): WagerTransaction => {
  const transaction = refund();
  waitForReference(transaction);
  return transaction;
};

describe('referenceRetryDelayMs', () => {
  test.each([
    [0, 1000],
    [1, 2000],
    [5, 32_000],
  ])('waits base × 2^attempts (attempts %p)', (attempts, expectedMs) => {
    expect(referenceRetryDelayMs(attempts, noJitter)).toBe(expectedMs);
  });

  test('never waits more than the cap, however many attempts', () => {
    expect(referenceRetryDelayMs(6, noJitter)).toBe(60_000);
    expect(referenceRetryDelayMs(5000, noJitter)).toBe(60_000);
  });

  test.each([
    [0, 800],
    [0.999_999, 1200],
  ])('jitters the delay by ±20%% (random %p)', (random, expectedMs) => {
    const delay = referenceRetryDelayMs(0, { ...noJitter, random: () => random });

    expect(Math.abs(delay - expectedMs)).toBeLessThanOrEqual(1);
  });

  test('stays within ±20% of the cap with the default randomness', () => {
    for (let i = 0; i < 100; i += 1) {
      const delay = referenceRetryDelayMs(100, { baseMs: 1000, maxMs: 60_000 });
      expect(delay).toBeGreaterThanOrEqual(48_000);
      expect(delay).toBeLessThanOrEqual(72_000);
    }
  });
});

describe('waitForReference', () => {
  test('leaves PENDING for PENDING_REFERENCE, with no attempt yet', () => {
    const transaction = pending();

    expect(transaction.status).toBe(WagerTransactionStatus.PendingReference);
    expect(transaction.attempts).toBe(0);
  });

  test('a pending reference keeps waiting, with no transition', () => {
    const transaction = pending();

    waitForReference(transaction);

    expect(transaction.status).toBe(WagerTransactionStatus.PendingReference);
  });

  test('a terminal transaction never waits', () => {
    const transaction = pending();
    transaction.fail(FailureCode.InfraUnexpected);

    expect(() => waitForReference(transaction)).toThrow(InvalidTransactionStateError);
  });
});

describe('WagerTransaction.scheduleReferenceAttempt', () => {
  test('the first attempt: due after the base delay, no attempt counted', () => {
    const transaction = pending();

    transaction.scheduleReferenceAttempt(NOW, noJitter);

    expect(transaction.attempts).toBe(0);
    expect(transaction.nextAttemptAt).toEqual(later(1000));
  });

  test('only a pending reference is scheduled', () => {
    expect(() => refund().scheduleReferenceAttempt(NOW, noJitter)).toThrow(InvalidTransactionStateError);
  });
});

describe('WagerTransaction.retryReference', () => {
  test('counts the attempt and waits base × 2^attempts', () => {
    const transaction = pending();
    transaction.scheduleReferenceAttempt(NOW, noJitter);

    transaction.retryReference(NOW, noJitter);
    transaction.retryReference(NOW, noJitter);

    expect(transaction.attempts).toBe(2);
    expect(transaction.nextAttemptAt).toEqual(later(4000));
    expect(transaction.status).toBe(WagerTransactionStatus.PendingReference);
  });

  test('a resolved transaction is never retried', () => {
    const transaction = pending();
    transaction.markProcessed({ at: NOW, balanceAfter: brl('20.00'), walletVersionObserved: 2 });

    expect(() => transaction.retryReference(NOW, noJitter)).toThrow(InvalidTransactionStateError);
  });
});
