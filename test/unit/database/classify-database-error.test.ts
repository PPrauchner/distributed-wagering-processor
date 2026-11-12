/**
 * Unit tests for the single database error classifier: every row of the table
 * in `ARCHITECTURE.md` § Classificação de falhas, by SQLSTATE and constraint
 * name. The rows whose constraint already exists are also covered through the
 * flush path, against the real PostgreSQL, by the integration tests.
 *
 * @packageDocumentation
 */
import { describe, expect, test } from 'bun:test';
import {
  classifyDatabaseError,
  isDatabaseError,
  type DatabaseErrorClass,
} from '../../../src/database/classify-database-error.ts';
import { FailureCode } from '../../../src/shared/domain/failure-code.ts';

/** What the driver throws: an error carrying the PostgreSQL fields. */
function pgError(code: string, constraint?: string): Error {
  return Object.assign(new Error(`sqlstate ${code}`), { code, constraint });
}

describe('classifyDatabaseError', () => {
  test.each<[string, Error, DatabaseErrorClass]>([
    ['lock_timeout (55P03)', pgError('55P03'), { category: 'transient', failureCode: FailureCode.TransientLockTimeout, lockConflict: 'lock_timeout' }],
    ['deadlock (40P01)', pgError('40P01'), { category: 'transient', failureCode: FailureCode.TransientLockTimeout, lockConflict: 'deadlock' }],
    ['serialization (40001)', pgError('40001'), { category: 'transient', failureCode: FailureCode.TransientLockTimeout, lockConflict: 'serialization_failure' }],
    ['connection refused', pgError('ECONNREFUSED'), { category: 'transient', failureCode: FailureCode.TransientUnavailable }],
    ['connection reset', pgError('ECONNRESET'), { category: 'transient', failureCode: FailureCode.TransientUnavailable }],
    ['connection failure (08006)', pgError('08006'), { category: 'transient', failureCode: FailureCode.TransientUnavailable }],
    ['admin shutdown (57P01)', pgError('57P01'), { category: 'transient', failureCode: FailureCode.TransientUnavailable }],
    ['cannot connect now (57P03)', pgError('57P03'), { category: 'transient', failureCode: FailureCode.TransientUnavailable }],
    ['too many connections (53300)', pgError('53300'), { category: 'transient', failureCode: FailureCode.TransientUnavailable }],
  ])('%s → transient', (_case, error, expected) => {
    expect(classifyDatabaseError(error)).toEqual(expected);
  });

  // `pg` and `pg-pool` throw these without a code; MikroORM's wrapper keeps the message.
  test.each([
    'Connection terminated unexpectedly',
    'Connection terminated',
    'Connection terminated due to connection timeout',
    'timeout exceeded when trying to connect',
    'Client has encountered a connection error and is not queryable',
    'Client was closed and is not queryable',
  ])('the driver connection failure without a code "%s" → transient', (message) => {
    const error = new Error(message);
    expect(isDatabaseError(error)).toBe(true);
    expect(classifyDatabaseError(error)).toEqual({
      category: 'transient',
      failureCode: FailureCode.TransientUnavailable,
    });
  });

  test.each<[string, string, DatabaseErrorClass]>([
    [
      'the provider idempotency key',
      'wager_transactions_provider_idempotency_key_unique',
      { category: 'reread', target: 'wager-transaction-idempotency-key' },
    ],
    [
      'the wallet creation key',
      'wallets_creation_idempotency_key_unique',
      { category: 'reread', target: 'wallet-creation-idempotency-key' },
    ],
    [
      'the provider external id',
      'wager_transactions_provider_external_id_unique',
      { category: 'conflict', failureCode: FailureCode.ExternalIdConflict },
    ],
    [
      'one wallet per player and currency',
      'wallets_player_currency_unique',
      { category: 'conflict', failureCode: FailureCode.WalletAlreadyExists },
    ],
    ['the inbox message', 'inbox_messages_pkey', { category: 'redelivery' }],
    [
      'the ledger entry per transaction and wallet',
      'wallet_ledger_entries_transaction_wallet_unique',
      { category: 'permanent', failureCode: FailureCode.InfraInvariantViolation },
    ],
    [
      'the ledger entry per wallet version',
      'wallet_ledger_entries_wallet_version_unique',
      { category: 'permanent', failureCode: FailureCode.InfraInvariantViolation },
    ],
    [
      'the single reversal per reference',
      'wager_transactions_single_reversal_unique',
      { category: 'permanent', failureCode: FailureCode.InfraInvariantViolation },
    ],
    [
      'an unknown constraint',
      'some_other_unique',
      { category: 'permanent', failureCode: FailureCode.InfraUnexpected },
    ],
  ])('23505 on %s', (_case, constraint, expected) => {
    expect(classifyDatabaseError(pgError('23505', constraint))).toEqual(expected);
  });

  test.each([
    ['CHECK (23514)', '23514'],
    ['currency foreign key (23503)', '23503'],
    ['NOT NULL (23502)', '23502'],
    ['trigger (23000)', '23000'],
    ['numeric overflow (22003)', '22003'],
  ])('%s → permanent INFRA_INVARIANT_VIOLATION', (_case, code) => {
    expect(classifyDatabaseError(pgError(code))).toEqual({
      category: 'permanent',
      failureCode: FailureCode.InfraInvariantViolation,
    });
  });

  test.each<[string, unknown]>([
    ['an unknown SQLSTATE', pgError('42P01')],
    ['an error without a code', new Error('boom')],
    ['something that is not an error', 'boom'],
  ])('%s → permanent INFRA_UNEXPECTED', (_case, error) => {
    expect(classifyDatabaseError(error)).toEqual({ category: 'permanent', failureCode: FailureCode.InfraUnexpected });
  });
});

describe('isDatabaseError', () => {
  test('recognizes driver and connection errors by their code', () => {
    expect(isDatabaseError(pgError('23505', 'x'))).toBe(true);
    expect(isDatabaseError(pgError('ECONNREFUSED'))).toBe(true);
  });

  test('leaves application errors alone', () => {
    expect(isDatabaseError(new Error('wallet not found'))).toBe(false);
    expect(isDatabaseError(undefined)).toBe(false);
  });
});
