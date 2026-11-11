/**
 * Unit tests for `WagerTransaction`: creation and its transitions (`ARCHITECTURE.md`
 * § Transições da transação de aposta).
 *
 * @packageDocumentation
 */
import { describe, expect, test } from 'bun:test';
import { FailureCode } from '../../../src/shared/domain/failure-code.ts';
import { Money } from '../../../src/shared/domain/money.ts';
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  type CreateWagerTransactionProps,
} from '../../../src/wagering/domain/wager-transaction.ts';

const WALLET_ID = '0192f291-27dd-7d3f-8071-5f8685deef37';
const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

const opening = (overrides: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps => ({
  id: '0192f291-27dd-7d3f-8071-5f8685deef38',
  providerId: 'internal',
  externalTransactionId: `opening:${WALLET_ID}`,
  idempotencyKey: `opening:${WALLET_ID}`,
  payloadHash: 'a'.repeat(64),
  walletId: WALLET_ID,
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  roundId: 'opening',
  gameId: 'opening',
  kind: WagerTransactionKind.Opening,
  money: brl('100.00'),
  correlationId: 'corr-1',
  ...overrides,
});

describe('WagerTransaction.create', () => {
  test('is born PENDING, with nothing of an outcome yet', () => {
    const transaction = WagerTransaction.create(opening());

    expect(transaction.status).toBe(WagerTransactionStatus.Pending);
    expect(transaction.kind).toBe(WagerTransactionKind.Opening);
    expect(transaction.correlationId).toBe('corr-1');
    expect(transaction.isTerminal()).toBe(false);
    expect(transaction.processedAt).toBeUndefined();
    expect(transaction.balanceAfter).toBeUndefined();
    expect(transaction.walletVersionObserved).toBeUndefined();
    expect(transaction.referenceTransactionId).toBeUndefined();
    expect(transaction.failureCode).toBeUndefined();
  });

  test('refuses a zero amount on a kind that moves the balance', () => {
    expect(() => WagerTransaction.create(opening({ money: brl('0.00') }))).toThrow(
      InvalidWagerTransactionError,
    );
  });

  test.each([
    ['an OPENING with a reference', opening({ referenceExternalTransactionId: 'bet-1' })],
    ['a REFUND without a reference', opening({ kind: WagerTransactionKind.Refund })],
    ['a ROLLBACK without a reference', opening({ kind: WagerTransactionKind.Rollback })],
    ...[WagerTransactionKind.Win, WagerTransactionKind.Refund, WagerTransactionKind.Rollback].map(
      (kind) =>
        [
          `a ${kind} citing itself`,
          opening({ kind, externalTransactionId: 'tx-1', referenceExternalTransactionId: 'tx-1' }),
        ] as const,
    ),
  ])('refuses %s', (_case, props) => {
    expect(() => WagerTransaction.create(props)).toThrow(InvalidWagerTransactionError);
  });
});

describe('WagerTransaction.markProcessed', () => {
  test('records when it was applied and the balance and version it left', () => {
    const transaction = WagerTransaction.create(opening());
    const at = new Date('2026-11-10T10:00:00Z');

    transaction.markProcessed({ at, balanceAfter: brl('100.00'), walletVersionObserved: 1 });

    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(transaction.isTerminal()).toBe(true);
    expect(transaction.processedAt).toEqual(at);
    expect(transaction.balanceAfter?.equals(brl('100.00'))).toBe(true);
    expect(transaction.walletVersionObserved).toBe(1);
  });

  test('a processed transaction is terminal: processing it again is a programming error', () => {
    const transaction = WagerTransaction.create(opening());
    const outcome = { at: new Date(), balanceAfter: brl('100.00'), walletVersionObserved: 1 };
    transaction.markProcessed(outcome);

    expect(() => transaction.markProcessed(outcome)).toThrow(InvalidTransactionStateError);
  });
});

const bet = (overrides: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps =>
  opening({
    providerId: 'provider-a',
    externalTransactionId: 'bet-1',
    idempotencyKey: 'provider-a:bet-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: brl('25.00'),
    ...overrides,
  });

describe('WagerTransaction.create for a BET', () => {
  test('takes a positive amount and no reference', () => {
    const transaction = WagerTransaction.create(bet());

    expect(transaction.kind).toBe(WagerTransactionKind.Bet);
    expect(transaction.status).toBe(WagerTransactionStatus.Pending);
  });

  test.each([
    ['a zero amount', bet({ money: brl('0.00') })],
    ['a reference', bet({ referenceExternalTransactionId: 'bet-0' })],
  ])('refuses %s', (_case, props) => {
    expect(() => WagerTransaction.create(props)).toThrow(InvalidWagerTransactionError);
  });
});

describe('WagerTransaction.reject', () => {
  test('records the failure code and the balance and version observed, with no processing time', () => {
    const transaction = WagerTransaction.create(bet());

    transaction.reject({
      code: FailureCode.InsufficientFunds,
      balanceAfter: brl('10.00'),
      walletVersionObserved: 3,
    });

    expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(transaction.isTerminal()).toBe(true);
    expect(transaction.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(transaction.balanceAfter?.equals(brl('10.00'))).toBe(true);
    expect(transaction.walletVersionObserved).toBe(3);
    expect(transaction.processedAt).toBeUndefined();
  });
});

describe('WagerTransaction.fail', () => {
  test('records the failure code and nothing observed', () => {
    const transaction = WagerTransaction.create(bet());

    transaction.fail(FailureCode.InfraUnexpected);

    expect(transaction.status).toBe(WagerTransactionStatus.Failed);
    expect(transaction.isTerminal()).toBe(true);
    expect(transaction.failureCode).toBe(FailureCode.InfraUnexpected);
    expect(transaction.balanceAfter).toBeUndefined();
    expect(transaction.walletVersionObserved).toBeUndefined();
  });
});

describe('WagerTransaction.markPendingReference', () => {
  const refund = (): WagerTransaction =>
    WagerTransaction.create(bet({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'bet-0' }));

  test('leaves PENDING for PENDING_REFERENCE, which is not terminal', () => {
    const transaction = refund();

    transaction.markPendingReference();

    expect(transaction.status).toBe(WagerTransactionStatus.PendingReference);
    expect(transaction.isTerminal()).toBe(false);
  });

  test('a pending reference can still be resolved', () => {
    const transaction = refund();
    transaction.markPendingReference();

    transaction.markProcessed({ at: new Date(), balanceAfter: brl('25.00'), walletVersionObserved: 2 });

    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
  });

  test('only leaves PENDING: a pending reference keeps waiting without a transition', () => {
    const transaction = refund();
    transaction.markPendingReference();

    expect(() => transaction.markPendingReference()).toThrow(InvalidTransactionStateError);
  });
});

describe('a terminal transaction never transitions', () => {
  const terminals: [string, (transaction: WagerTransaction) => void][] = [
    ['PROCESSED', (t) => t.markProcessed({ at: new Date(), balanceAfter: brl('75.00'), walletVersionObserved: 2 })],
    [
      'REJECTED',
      (t) => t.reject({ code: FailureCode.InsufficientFunds, balanceAfter: brl('1.00'), walletVersionObserved: 1 }),
    ],
    ['FAILED', (t) => t.fail(FailureCode.InfraUnexpected)],
  ];
  const transitions: [string, (transaction: WagerTransaction) => void][] = [
    ['markProcessed', (t) => t.markProcessed({ at: new Date(), balanceAfter: brl('1.00'), walletVersionObserved: 1 })],
    ['reject', (t) => t.reject({ code: FailureCode.CurrencyMismatch, balanceAfter: brl('1.00'), walletVersionObserved: 1 })],
    ['fail', (t) => t.fail(FailureCode.InfraUnexpected)],
    ['markPendingReference', (t) => t.markPendingReference()],
  ];

  for (const [status, reach] of terminals) {
    test.each(transitions)(`${status} → %s is a programming error`, (_name, transition) => {
      const transaction = WagerTransaction.create(bet());
      reach(transaction);

      expect(() => transition(transaction)).toThrow(InvalidTransactionStateError);
      expect(transaction.status).toBe(status as WagerTransactionStatus);
    });
  }
});
