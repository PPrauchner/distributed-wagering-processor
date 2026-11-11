/**
 * Infrastructure failures as the use cases see them, already classified by the
 * unit of work (`ARCHITECTURE.md` § Classificação de falhas): transient —
 * nothing recorded, resend with the same key — or permanent — a bug or an
 * unknown error, recorded as `FAILED`.
 *
 * @packageDocumentation
 */
import { FailureCode } from '../domain/failure-code.ts';

export type TransientFailureCode = FailureCode.TransientLockTimeout | FailureCode.TransientUnavailable;
export type PermanentFailureCode = FailureCode.InfraInvariantViolation | FailureCode.InfraUnexpected;

/** Lock conflict or database unavailable: resend with the same key. */
export class TransientFailureError extends Error {
  override readonly name = 'TransientFailureError';

  constructor(
    readonly failureCode: TransientFailureCode,
    options?: ErrorOptions,
  ) {
    super(
      failureCode === FailureCode.TransientLockTimeout
        ? 'the wallet is busy; resend with the same key'
        : 'the service is temporarily unavailable; resend with the same key',
      options,
    );
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
