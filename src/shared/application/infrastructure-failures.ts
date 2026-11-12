/**
 * Infrastructure failures as the use cases see them, already classified by the
 * unit of work (`ARCHITECTURE.md` § Classificação de falhas): transient —
 * nothing recorded, resend with the same key — or permanent — a bug or an
 * unknown error, recorded as `FAILED`.
 *
 * @packageDocumentation
 */
import { FailureCode } from '../domain/failure-code.ts';

/** The failure codes of a transient failure: the ones a consumer retries on. */
export const TRANSIENT_FAILURE_CODES = [FailureCode.TransientLockTimeout, FailureCode.TransientUnavailable] as const;
export type TransientFailureCode = (typeof TRANSIENT_FAILURE_CODES)[number];
export type PermanentFailureCode = FailureCode.InfraInvariantViolation | FailureCode.InfraUnexpected;

/** Why the database refused the lock: its own timeout, a deadlock or a serialization failure. */
export const LOCK_CONFLICT_REASONS = ['lock_timeout', 'deadlock', 'serialization_failure'] as const;
export type LockConflictReason = (typeof LOCK_CONFLICT_REASONS)[number];

/** Lock conflict or database unavailable: resend with the same key. */
export class TransientFailureError extends Error {
  override readonly name = 'TransientFailureError';
  /** Set on a lock conflict, for the metrics. */
  readonly lockConflict: LockConflictReason | undefined;

  constructor(
    readonly failureCode: TransientFailureCode,
    options?: ErrorOptions & { lockConflict?: LockConflictReason },
  ) {
    super(
      failureCode === FailureCode.TransientLockTimeout
        ? 'the wallet is busy; resend with the same key'
        : 'the service is temporarily unavailable; resend with the same key',
      options,
    );
    this.lockConflict = options?.lockConflict;
  }
}

/** A permanent infrastructure error: no business decision was made. */
export class PermanentFailureError extends Error {
  override readonly name = 'PermanentFailureError';

  constructor(
    readonly failureCode: PermanentFailureCode,
    options?: ErrorOptions,
  ) {
    super(`permanent infrastructure failure: ${failureCode}`, options);
  }
}
