/**
 * Unit tests for the `REFUND` and `ROLLBACK` rules: a dependent transaction
 * undoes its reference once, by any kind, applying the inverse — resolved and
 * checked in the documented order (`ARCHITECTURE.md` § Ordem das validações,
 * step 8; § Reembolso e reversão).
 *
 * @packageDocumentation
 */
import { describe, expect, test } from 'bun:test';
import { FailureCode } from '../../../src/shared/domain/failure-code.ts';
import { Money } from '../../../src/shared/domain/money.ts';
import { applyDependentTransaction, type CitedReference } from '../../../src/wagering/domain/dependent-transaction.ts';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  type CreateWagerTransactionProps,
} from '../../../src/wagering/domain/wager-transaction.ts';
import { Wallet } from '../../../src/wallet/domain/wallet.ts';
import { LedgerDirection } from '../../../src/wallet/domain/wallet-ledger-entry.ts';

const WALLET_ID = '0192f291-27dd-7d3f-8071-5f8685deef37';
const PLAYER_ID = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
const REFERENCE_ID = '0192f298-0000-7000-8000-0000000000be';
const ENTRY_ID = '0192f299-0000-7000-8000-000000000001';
const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string): Money => Money.from({ amount, currency: 'USD' });
const ids = { entryId: ENTRY_ID };

const props = (overrides: Partial<CreateWagerTransactionProps>): CreateWagerTransactionProps => ({
  id: '0192f298-345e-7e38-af88-e43f851a819d',
  providerId: 'provider-a',
  externalTransactionId: 'undo-1',
  idempotencyKey: 'provider-a:undo-1',
  payloadHash: 'a'.repeat(64),
  walletId: WALLET_ID,
  playerId: PLAYER_ID,
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: WagerTransactionKind.Refund,
  money: brl('20.00'),
  referenceExternalTransactionId: 'ref-1',
  correlationId: 'corr-1',
  ...overrides,
});

const refund = (overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction =>
  WagerTransaction.create(props(overrides));

const rollback = (overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction =>
  WagerTransaction.create(props({ kind: WagerTransactionKind.Rollback, ...overrides }));

/** The cited transaction of the round, processed unless the status says otherwise. */
function referenceOf(
  kind: WagerTransactionKind,
  overrides: Partial<CreateWagerTransactionProps> = {},
  status: WagerTransactionStatus = WagerTransactionStatus.Processed,
): WagerTransaction {
  const needsReference = kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback;
  const reference = WagerTransaction.create(
    props({
      id: REFERENCE_ID,
      externalTransactionId: 'ref-1',
      kind,
      referenceExternalTransactionId: needsReference ? 'earlier' : undefined,
      ...overrides,
    }),
  );
  const observed = { balanceAfter: brl('80.00'), walletVersionObserved: 2 };
  if (status === WagerTransactionStatus.Processed) reference.markProcessed({ at: new Date(), ...observed });
  if (status === WagerTransactionStatus.Rejected) reference.reject({ code: FailureCode.InsufficientFunds, ...observed });
  if (status === WagerTransactionStatus.Failed) reference.fail(FailureCode.InfraUnexpected);
  if (status === WagerTransactionStatus.PendingReference) reference.markPendingReference();
  return reference;
}

const cited = (reference: WagerTransaction, alreadyReversed = false): CitedReference => ({
  transaction: reference,
  alreadyReversed,
});

const walletWith = (balance: Money): Wallet =>
  Wallet.open({ id: WALLET_ID, playerId: PLAYER_ID, initialBalance: balance });

describe('a REFUND', () => {
  test('of a processed BET: credits the same amount, bumps the version and records the reference', () => {
    const wallet = walletWith(brl('100.00'));
    const transaction = refund();

    const entry = applyDependentTransaction(transaction, wallet, cited(referenceOf(WagerTransactionKind.Bet)), ids);

    expect(entry?.direction).toBe(LedgerDirection.Credit);
    expect(entry?.money.equals(brl('20.00'))).toBe(true);
    expect(wallet.balance.equals(brl('120.00'))).toBe(true);
    expect(wallet.version).toBe(2);
    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(transaction.balanceAfter?.equals(brl('120.00'))).toBe(true);
    expect(transaction.walletVersionObserved).toBe(2);
    expect(transaction.referenceTransactionId).toBe(REFERENCE_ID);
  });
});

describe('a ROLLBACK applies the inverse of its reference', () => {
  test.each<[WagerTransactionKind, LedgerDirection, string]>([
    [WagerTransactionKind.Bet, LedgerDirection.Credit, '120.00'],
    [WagerTransactionKind.Win, LedgerDirection.Debit, '80.00'],
    [WagerTransactionKind.Refund, LedgerDirection.Debit, '80.00'],
  ])('of a processed %s: %s, processed with the reference recorded', (kind, direction, balance) => {
    const wallet = walletWith(brl('100.00'));
    const transaction = rollback();

    const entry = applyDependentTransaction(transaction, wallet, cited(referenceOf(kind)), ids);

    expect(entry?.direction).toBe(direction);
    expect(wallet.balance.equals(brl(balance))).toBe(true);
    expect(wallet.version).toBe(2);
    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(transaction.referenceTransactionId).toBe(REFERENCE_ID);
  });

  test.each([WagerTransactionKind.Win, WagerTransactionKind.Refund])(
    'of a %s with too little balance: rejected REVERSAL_INSUFFICIENT_FUNDS, the wallet untouched and observed',
    (kind) => {
      const wallet = walletWith(brl('19.99'));
      const transaction = rollback();

      const entry = applyDependentTransaction(transaction, wallet, cited(referenceOf(kind)), ids);

      expect(entry).toBeUndefined();
      expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
      expect(transaction.failureCode).toBe(FailureCode.ReversalInsufficientFunds);
      expect(transaction.balanceAfter?.equals(brl('19.99'))).toBe(true);
      expect(transaction.walletVersionObserved).toBe(1);
      expect(wallet.version).toBe(1);
    },
  );

  test('of a WIN leaving the balance at exactly zero: processed', () => {
    const wallet = walletWith(brl('20.00'));
    const transaction = rollback();

    applyDependentTransaction(transaction, wallet, cited(referenceOf(WagerTransactionKind.Win)), ids);

    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(wallet.balance.equals(brl('0.00'))).toBe(true);
  });

  test('of a BET with an empty wallet: credits, never short of funds', () => {
    const wallet = walletWith(brl('0.00'));
    const transaction = rollback();

    applyDependentTransaction(transaction, wallet, cited(referenceOf(WagerTransactionKind.Bet)), ids);

    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
  });
});

describe('the reference rules of a REFUND and a ROLLBACK', () => {
  test.each<[string, () => WagerTransaction, WagerTransactionKind]>([
    ['a REFUND of a WIN', refund, WagerTransactionKind.Win],
    ['a REFUND of a LOSS', refund, WagerTransactionKind.Loss],
    ['a REFUND of a REFUND', refund, WagerTransactionKind.Refund],
    ['a REFUND of a ROLLBACK', refund, WagerTransactionKind.Rollback],
    ['a ROLLBACK of a LOSS', rollback, WagerTransactionKind.Loss],
    ['a ROLLBACK of a ROLLBACK', rollback, WagerTransactionKind.Rollback],
  ])('%s: rejected REFERENCE_KIND_NOT_ALLOWED', (_case, create, kind) => {
    const transaction = create();

    applyDependentTransaction(transaction, walletWith(brl('100.00')), cited(referenceOf(kind)), ids);

    expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(transaction.failureCode).toBe(FailureCode.ReferenceKindNotAllowed);
  });

  test.each<[string, CitedReference | undefined]>([
    ['absent', undefined],
    [
      'itself waiting for its reference',
      cited(referenceOf(WagerTransactionKind.Refund, {}, WagerTransactionStatus.PendingReference)),
    ],
  ])('a reference %s: waits as PENDING_REFERENCE, nothing observed, the wallet untouched', (_case, reference) => {
    const wallet = walletWith(brl('100.00'));
    const transaction = rollback();

    const entry = applyDependentTransaction(transaction, wallet, reference, ids);

    expect(entry).toBeUndefined();
    expect(transaction.status).toBe(WagerTransactionStatus.PendingReference);
    expect(transaction.balanceAfter).toBeUndefined();
    expect(wallet.version).toBe(1);
  });

  test.each([WagerTransactionStatus.Rejected, WagerTransactionStatus.Failed])(
    'a %s reference: rejected REFERENCE_NOT_PROCESSED',
    (status) => {
      const transaction = refund();
      const reference = cited(referenceOf(WagerTransactionKind.Bet, {}, status));

      applyDependentTransaction(transaction, walletWith(brl('100.00')), reference, ids);

      expect(transaction.failureCode).toBe(FailureCode.ReferenceNotProcessed);
    },
  );

  test.each<[string, Partial<CreateWagerTransactionProps>]>([
    ['playerId', { playerId: 'someone-else' }],
    ['walletId', { walletId: '0192f291-27dd-7d3f-8071-000000000000' }],
    ['currency', { money: usd('20.00') }],
    ['roundId', { roundId: 'another-round' }],
  ])('a reference with another %s: rejected REFERENCE_MISMATCH naming the field', (field, overrides) => {
    const wallet = walletWith(brl('100.00'));
    const transaction = refund();

    applyDependentTransaction(transaction, wallet, cited(referenceOf(WagerTransactionKind.Bet, overrides)), ids);

    expect(transaction.failureCode).toBe(FailureCode.ReferenceMismatch);
    expect(transaction.failureMessage).toContain(field);
    expect(transaction.balanceAfter?.equals(brl('100.00'))).toBe(true);
    expect(wallet.version).toBe(1);
  });

  test.each([
    ['REFUND', refund],
    ['ROLLBACK', rollback],
  ])('a %s of another amount than the reference: rejected REFERENCE_AMOUNT_MISMATCH', (_kind, create) => {
    const wallet = walletWith(brl('100.00'));
    const transaction = create({ money: brl('19.99') });

    const entry = applyDependentTransaction(transaction, wallet, cited(referenceOf(WagerTransactionKind.Bet)), ids);

    expect(entry).toBeUndefined();
    expect(transaction.failureCode).toBe(FailureCode.ReferenceAmountMismatch);
    expect(wallet.version).toBe(1);
  });

  test.each([
    ['REFUND', refund],
    ['ROLLBACK', rollback],
  ])('a %s of a reference already undone: rejected REFERENCE_ALREADY_REVERSED', (_kind, create) => {
    const wallet = walletWith(brl('100.00'));
    const transaction = create();

    const entry = applyDependentTransaction(
      transaction,
      wallet,
      cited(referenceOf(WagerTransactionKind.Bet), true),
      ids,
    );

    expect(entry).toBeUndefined();
    expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(transaction.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    expect(transaction.balanceAfter?.equals(brl('100.00'))).toBe(true);
    expect(wallet.version).toBe(1);
  });

  test('is only for a REFUND or a ROLLBACK', () => {
    const transaction = refund({ kind: WagerTransactionKind.Win });

    expect(() => applyDependentTransaction(transaction, walletWith(brl('100.00')), undefined, ids)).toThrow();
  });
});

describe('with more than one violation, the first in order wins', () => {
  test.each<[string, Partial<CreateWagerTransactionProps>, CitedReference | undefined, FailureCode]>([
    ['player beats the reference', { playerId: 'someone-else' }, undefined, FailureCode.WalletPlayerMismatch],
    ['currency beats the reference', { money: usd('20.00') }, undefined, FailureCode.CurrencyMismatch],
    [
      'not processed beats kind',
      {},
      cited(referenceOf(WagerTransactionKind.Loss, {}, WagerTransactionStatus.Rejected)),
      FailureCode.ReferenceNotProcessed,
    ],
    [
      'kind beats mismatch',
      {},
      cited(referenceOf(WagerTransactionKind.Loss, { roundId: 'other' })),
      FailureCode.ReferenceKindNotAllowed,
    ],
    [
      'mismatch beats amount',
      {},
      cited(referenceOf(WagerTransactionKind.Win, { roundId: 'other', money: brl('5.00') })),
      FailureCode.ReferenceMismatch,
    ],
    [
      'amount beats already reversed',
      {},
      cited(referenceOf(WagerTransactionKind.Win, { money: brl('5.00') }), true),
      FailureCode.ReferenceAmountMismatch,
    ],
    [
      'already reversed beats funds',
      {},
      cited(referenceOf(WagerTransactionKind.Win), true),
      FailureCode.ReferenceAlreadyReversed,
    ],
  ])('%s', (_case, overrides, reference, code) => {
    const transaction = rollback(overrides);

    applyDependentTransaction(transaction, walletWith(brl('10.00')), reference, ids);

    expect(transaction.failureCode).toBe(code);
  });
});
