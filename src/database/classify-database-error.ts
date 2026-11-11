/**
 * The single database error classifier (`ARCHITECTURE.md` § Classificação de
 * falhas): maps what the driver or MikroORM threw — by SQLSTATE and, for a
 * unique violation, by constraint name — to a closed category and its failure
 * code. `REJECTED` never comes from here: it comes only from the domain.
 *
 * One constraint of the table does not exist yet (wallet creation key); it is
 * mapped already so the classifier stays the only place that knows the names,
 * and the slice that creates it adds its integration test.
 *
 * @packageDocumentation
 */
import type { LockConflictReason } from '../shared/application/infrastructure-failures.ts';
import { FailureCode } from '../shared/domain/failure-code.ts';

/** What a database error means to the caller. */
export type DatabaseErrorClass =
  /** Nothing was recorded; resend with the same key. A lock conflict says which one. */
  | { category: 'transient'; failureCode: FailureCode.TransientLockTimeout; lockConflict: LockConflictReason }
  | { category: 'transient'; failureCode: FailureCode.TransientUnavailable }
  /** A bug or an unknown error: the transaction is recorded as `FAILED`. */
  | { category: 'permanent'; failureCode: FailureCode.InfraInvariantViolation | FailureCode.InfraUnexpected }
  /** A concurrent submission recorded the key: read it back and compare the hash. */
  | { category: 'reread'; target: 'wager-transaction-idempotency-key' | 'wallet-creation-idempotency-key' }
  /** A legitimate conflict that escaped the wallet lock. */
  | { category: 'conflict'; failureCode: FailureCode.ExternalIdConflict | FailureCode.WalletAlreadyExists }
  /** The queue delivered a message the inbox already holds: acknowledge it. */
  | { category: 'redelivery' };

const UNIQUE_VIOLATION = '23505';

const LOCK_CONFLICTS = new Map<string, LockConflictReason>([
  ['55P03', 'lock_timeout'], // lock_not_available: lock_timeout expired (MikroORM does not map it)
  ['40P01', 'deadlock'], // deadlock_detected
  ['40001', 'serialization_failure'],
]);

// Node's network errors, raised before PostgreSQL answers anything.
const NETWORK_ERRORS = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

const UNAVAILABLE_STATES = new Set([
  '53300', // too_many_connections
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
]);

const INVARIANT_VIOLATIONS = new Set([
  '23000', // integrity_constraint_violation: raised by the schema's triggers
  '23502', // not_null_violation
  '23503', // foreign_key_violation: the ledger's currency key
  '23514', // check_violation
  '22003', // numeric_value_out_of_range: a balance beyond numeric(19,2)
]);

const UNIQUE_CONSTRAINTS: Record<string, DatabaseErrorClass> = {
  wager_transactions_provider_idempotency_key_unique: {
    category: 'reread',
    target: 'wager-transaction-idempotency-key',
  },
  wallets_creation_idempotency_key_unique: { category: 'reread', target: 'wallet-creation-idempotency-key' },
  wager_transactions_provider_external_id_unique: {
    category: 'conflict',
    failureCode: FailureCode.ExternalIdConflict,
  },
  wallets_player_currency_unique: { category: 'conflict', failureCode: FailureCode.WalletAlreadyExists },
  inbox_messages_pkey: { category: 'redelivery' },
  // Serialized by the wallet lock: the domain would have seen them first.
  wallet_ledger_entries_transaction_wallet_unique: invariantViolation(),
  wallet_ledger_entries_wallet_version_unique: invariantViolation(),
  wager_transactions_single_reversal_unique: invariantViolation(),
};

/**
 * @param error - Whatever the driver or MikroORM threw.
 * @returns Its category and, when it has one, its failure code; anything not
 *   recognized is permanent `INFRA_UNEXPECTED`.
 */
export function classifyDatabaseError(error: unknown): DatabaseErrorClass {
  const code = errorCode(error);
  if (code === undefined) return unexpected();
  const lockConflict = LOCK_CONFLICTS.get(code);
  if (lockConflict) return { category: 'transient', failureCode: FailureCode.TransientLockTimeout, lockConflict };
  if (isConnectionFailure(code)) return { category: 'transient', failureCode: FailureCode.TransientUnavailable };
  if (code === UNIQUE_VIOLATION) return UNIQUE_CONSTRAINTS[violatedConstraint(error) ?? ''] ?? unexpected();
  if (INVARIANT_VIOLATIONS.has(code)) return invariantViolation();
  return unexpected();
}

/**
 * @param error - Whatever a unit of work threw.
 * @returns Whether it came from the database or the connection to it — an
 *   error carrying a SQLSTATE or a network error code — rather than from the
 *   application.
 */
export function isDatabaseError(error: unknown): boolean {
  const code = errorCode(error);
  return code !== undefined && (SQLSTATE.test(code) || NETWORK_ERRORS.has(code));
}

const SQLSTATE = /^[0-9A-Z]{5}$/;

function isConnectionFailure(code: string): boolean {
  // Class 08: connection_exception.
  return NETWORK_ERRORS.has(code) || UNAVAILABLE_STATES.has(code) || code.startsWith('08');
}

// The driver error, and MikroORM's wrapper of it, copy the PostgreSQL error's
// own fields: `code` (the SQLSTATE, or Node's network code) and `constraint`.
function errorCode(error: unknown): string | undefined {
  return stringField(error, 'code');
}

function violatedConstraint(error: unknown): string | undefined {
  return stringField(error, 'constraint');
}

function stringField(error: unknown, field: string): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const value: unknown = Reflect.get(error, field);
  return typeof value === 'string' ? value : undefined;
}

function invariantViolation(): DatabaseErrorClass {
  return { category: 'permanent', failureCode: FailureCode.InfraInvariantViolation };
}

function unexpected(): DatabaseErrorClass {
  return { category: 'permanent', failureCode: FailureCode.InfraUnexpected };
}
