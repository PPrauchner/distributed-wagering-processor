/**
 * Unit tests for the `WIN` rules: a credit with no reference, or citing the
 * round's bet — resolved and checked in the documented order (`ARCHITECTURE.md`
 * § Ordem das validações, step 8; § Reembolso e reversão, "Referência do ganho").
 *
 * @packageDocumentation
 */
import { describe, expect, test } from 'bun:test';
import { FailureCode } from '../../../src/shared/domain/failure-code.ts';
import { Money } from '../../../src/shared/domain/money.ts';
import { applyWin } from '../../../src/wagering/domain/win.ts';
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
const BET_ID = '0192f298-0000-7000-8000-0000000000be';
const ENTRY_ID = '0192f299-0000-7000-8000-000000000001';
const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string): Money => Money.from({ amount, currency: 'USD' });

const props = (overrides: Partial<CreateWagerTransactionProps>): CreateWagerTransactionProps => ({
  id: '0192f298-345e-7e38-af88-e43f851a819d',
  providerId: 'provider-a',
  externalTransactionId: 'win-1',
  idempotencyKey: 'provider-a:win-1',
  payloadHash: 'a'.repeat(64),
  walletId: WALLET_ID,
  playerId: PLAYER_ID,
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: WagerTransactionKind.Win,
  money: brl('150.00'),
  correlationId: 'corr-1',
  ...overrides,
});

const win = (overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction =>
  WagerTransaction.create(props(overrides));

const citing = (overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction =>
  win({ referenceExternalTransactionId: 'bet-1', ...overrides });

/** The round's bet, processed unless the status says otherwise. */
function betOfRound(
  overrides: Partial<CreateWagerTransactionProps> = {},
  status: WagerTransactionStatus = WagerTransactionStatus.Processed,
): WagerTransaction {
  const bet = WagerTransaction.create(
    props({ id: BET_ID, externalTransactionId: 'bet-1', kind: WagerTransactionKind.Bet, money: brl('20.00'), ...overrides }),
  );
  const observed = { balanceAfter: brl('80.00'), walletVersionObserved: 2 };
  if (status === WagerTransactionStatus.Processed) bet.markProcessed({ at: new Date(), ...observed });
  if (status === WagerTransactionStatus.Rejected) bet.reject({ code: FailureCode.InsufficientFunds, ...observed });
  if (status === WagerTransactionStatus.Failed) bet.fail(FailureCode.InfraUnexpected);
  if (status === WagerTransactionStatus.PendingReference) bet.markPendingReference();
  return bet;
}

const walletWith = (balance: Money): Wallet =>
  Wallet.open({ id: WALLET_ID, playerId: PLAYER_ID, initialBalance: balance });

describe('applyWin without a reference', () => {
  test('credits, bumps the version and processes the win with the balance it left', () => {
    const wallet = walletWith(brl('100.00'));
    const transaction = win();

    const entry = applyWin(transaction, wallet, undefined, { entryId: ENTRY_ID });

    expect(wallet.balance.equals(brl('250.00'))).toBe(true);
    expect(wallet.version).toBe(2);
    expect(entry?.direction).toBe(LedgerDirection.Credit);
    expect(entry?.transactionId).toBe(transaction.id);
    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(transaction.balanceAfter?.equals(brl('250.00'))).toBe(true);
    expect(transaction.walletVersionObserved).toBe(2);
    expect(transaction.referenceTransactionId).toBeUndefined();
  });

  test.each([
    ['another player', { playerId: 'someone-else' }, FailureCode.WalletPlayerMismatch],
    ['another currency', { money: usd('10.00') }, FailureCode.CurrencyMismatch],
    ['another player and currency', { playerId: 'someone-else', money: usd('10.00') }, FailureCode.WalletPlayerMismatch],
  ])('with %s: rejected, the wallet untouched and its balance observed', (_case, overrides, code) => {
    const wallet = walletWith(brl('100.00'));
    const transaction = win(overrides);

    const entry = applyWin(transaction, wallet, undefined, { entryId: ENTRY_ID });

    expect(entry).toBeUndefined();
    expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(transaction.failureCode).toBe(code);
    expect(transaction.balanceAfter?.equals(brl('100.00'))).toBe(true);
    expect(wallet.version).toBe(1);
  });

  test('is only for a WIN', () => {
    const transaction = win({ kind: WagerTransactionKind.Bet });

    expect(() => applyWin(transaction, walletWith(brl('100.00')), undefined, { entryId: ENTRY_ID })).toThrow();
  });
});

describe('applyWin citing the bet of its round', () => {
  test('a coherent processed BET: credits, whatever its amount, and records the reference', () => {
    const wallet = walletWith(brl('100.00'));
    const transaction = citing();
    const bet = betOfRound();

    const entry = applyWin(transaction, wallet, bet, { entryId: ENTRY_ID });

    expect(entry?.direction).toBe(LedgerDirection.Credit);
    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(transaction.referenceTransactionId).toBe(BET_ID);
    expect(bet.status).toBe(WagerTransactionStatus.Processed);
  });

  test.each<[string, WagerTransaction | undefined]>([
    ['absent', undefined],
    ['itself waiting for its reference', betOfRound({ kind: WagerTransactionKind.Win, referenceExternalTransactionId: 'x' }, WagerTransactionStatus.PendingReference)],
  ])('a reference %s: waits as PENDING_REFERENCE, nothing observed, the wallet untouched', (_case, reference) => {
    const wallet = walletWith(brl('100.00'));
    const transaction = citing();

    const entry = applyWin(transaction, wallet, reference, { entryId: ENTRY_ID });

    expect(entry).toBeUndefined();
    expect(transaction.status).toBe(WagerTransactionStatus.PendingReference);
    expect(transaction.balanceAfter).toBeUndefined();
    expect(transaction.walletVersionObserved).toBeUndefined();
    expect(wallet.version).toBe(1);
  });

  test.each([WagerTransactionStatus.Rejected, WagerTransactionStatus.Failed])(
    'a %s BET: rejected REFERENCE_NOT_PROCESSED',
    (status) => {
      const transaction = citing();

      applyWin(transaction, walletWith(brl('100.00')), betOfRound({}, status), { entryId: ENTRY_ID });

      expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
      expect(transaction.failureCode).toBe(FailureCode.ReferenceNotProcessed);
    },
  );

  test.each([
    [WagerTransactionKind.Win, {}],
    [WagerTransactionKind.Loss, { money: brl('0.00') }],
    [WagerTransactionKind.Refund, { referenceExternalTransactionId: 'x' }],
    [WagerTransactionKind.Rollback, { referenceExternalTransactionId: 'x' }],
  ])('a processed %s: rejected REFERENCE_KIND_NOT_ALLOWED', (kind, overrides) => {
    const transaction = citing();

    applyWin(transaction, walletWith(brl('100.00')), betOfRound({ kind, ...overrides }), { entryId: ENTRY_ID });

    expect(transaction.failureCode).toBe(FailureCode.ReferenceKindNotAllowed);
  });

  test.each<[string, Partial<CreateWagerTransactionProps>]>([
    ['playerId', { playerId: 'someone-else' }],
    ['walletId', { walletId: '0192f291-27dd-7d3f-8071-000000000000' }],
    ['currency', { money: usd('20.00') }],
    ['roundId', { roundId: 'another-round' }],
  ])('a BET with another %s: rejected REFERENCE_MISMATCH naming the field', (field, overrides) => {
    const wallet = walletWith(brl('100.00'));
    const transaction = citing();

    const entry = applyWin(transaction, wallet, betOfRound(overrides), { entryId: ENTRY_ID });

    expect(entry).toBeUndefined();
    expect(transaction.failureCode).toBe(FailureCode.ReferenceMismatch);
    expect(transaction.failureMessage).toContain(field);
    expect(transaction.balanceAfter?.equals(brl('100.00'))).toBe(true);
    expect(wallet.version).toBe(1);
  });

  test('several divergent fields: the message names the first, in the order player, wallet, currency, round', () => {
    const transaction = citing();

    applyWin(transaction, walletWith(brl('100.00')), betOfRound({ money: usd('20.00'), roundId: 'other' }), {
      entryId: ENTRY_ID,
    });

    expect(transaction.failureMessage).toContain('currency');
    expect(transaction.failureMessage).not.toContain('roundId');
  });

  test.each<[string, WagerTransaction, FailureCode]>([
    ['not processed beats kind', betOfRound({ kind: WagerTransactionKind.Win }, WagerTransactionStatus.Rejected), FailureCode.ReferenceNotProcessed],
    ['kind beats mismatch', betOfRound({ kind: WagerTransactionKind.Win, roundId: 'other' }), FailureCode.ReferenceKindNotAllowed],
  ])('the first rule in order wins: %s', (_case, reference, code) => {
    const transaction = citing();

    applyWin(transaction, walletWith(brl('100.00')), reference, { entryId: ENTRY_ID });

    expect(transaction.failureCode).toBe(code);
  });

  test('the wallet checks come before the reference', () => {
    const transaction = citing({ playerId: 'someone-else' });

    applyWin(transaction, walletWith(brl('100.00')), undefined, { entryId: ENTRY_ID });

    expect(transaction.failureCode).toBe(FailureCode.WalletPlayerMismatch);
  });
});
