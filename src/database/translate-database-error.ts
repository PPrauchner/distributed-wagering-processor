/**
 * Translates database errors into application errors, by the category the
 * single classifier gives them. Errors raised by the application itself pass
 * through untouched.
 *
 * @packageDocumentation
 */
import { InboxRedeliveryError } from '../messaging/application/inbox-repository.ts';
import { PermanentFailureError, TransientFailureError } from '../shared/application/infrastructure-failures.ts';
import { FailureCode } from '../shared/domain/failure-code.ts';
import {
  DuplicateExternalIdError,
  DuplicateIdempotencyKeyError,
} from '../wagering/application/wagering-errors.ts';
import { DuplicateWalletError } from '../wallet/application/wallet-errors.ts';
import { classifyDatabaseError, isDatabaseError } from './classify-database-error.ts';

/**
 * @param error - Whatever the unit of work threw.
 * @returns The application error it means, or the error itself when it did not
 *   come from the database or has no application meaning yet.
 */
export function translateDatabaseError(error: unknown): unknown {
  if (!isDatabaseError(error)) return error;
  const classified = classifyDatabaseError(error);
  const message = (error as Error).message;
  switch (classified.category) {
    case 'transient':
      return new TransientFailureError(classified.failureCode, {
        cause: error,
        lockConflict: 'lockConflict' in classified ? classified.lockConflict : undefined,
      });
    case 'permanent':
      return new PermanentFailureError(classified.failureCode, { cause: error });
    case 'conflict':
      return classified.failureCode === FailureCode.WalletAlreadyExists
        ? new DuplicateWalletError(message)
        : new DuplicateExternalIdError(message);
    case 'reread':
      // The wallet creation key arrives with the idempotent-creation slice.
      return classified.target === 'wager-transaction-idempotency-key'
        ? new DuplicateIdempotencyKeyError(message)
        : error;
    case 'redelivery':
      return new InboxRedeliveryError(message, { cause: error });
  }
}
