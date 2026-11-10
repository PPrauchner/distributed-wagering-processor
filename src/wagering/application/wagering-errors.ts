/**
 * Errors the wagering use cases raise for a submission that does not become a
 * transaction — refused before or without one (`ARCHITECTURE.md` § Submissões
 * não admitidas). A rejection is not among them: it is a transaction outcome.
 *
 * @packageDocumentation
 */

/** The submission has no idempotency key, or an empty one. */
export class MissingIdempotencyKeyError extends Error {
  override readonly name = 'MissingIdempotencyKeyError';

  constructor() {
    super('the Idempotency-Key header is required');
  }
}

/** A well-formed `OPENING` from outside: it is internal only. */
export class InternalKindNotAllowedError extends Error {
  override readonly name = 'InternalKindNotAllowedError';

  constructor(kind: string) {
    super(`${kind} is internal and cannot be submitted`);
  }
}

/** A kind this service does not process yet. */
export class UnsupportedKindError extends Error {
  override readonly name = 'UnsupportedKindError';

  constructor(kind: string) {
    super(`${kind} is not supported yet`);
  }
}

/** The idempotency key was already used by this provider with another payload. */
export class IdempotencyConflictError extends Error {
  override readonly name = 'IdempotencyConflictError';

  constructor(providerId: string, idempotencyKey: string) {
    super(`idempotency key "${idempotencyKey}" of provider "${providerId}" was used with another payload`);
  }
}

/** The external transaction id was already used by this provider with another key. */
export class ExternalIdConflictError extends Error {
  override readonly name = 'ExternalIdConflictError';

  constructor(providerId: string, externalTransactionId: string) {
    super(
      `external transaction id "${externalTransactionId}" of provider "${providerId}" was used with another idempotency key`,
    );
  }
}

/**
 * Raised by the unit of work when the commit hits the provider's idempotency
 * key: a concurrent submission of the same key won the race, outside the
 * wallet lock. The use case reads it back — replay or conflict.
 */
export class DuplicateIdempotencyKeyError extends Error {
  override readonly name = 'DuplicateIdempotencyKeyError';
}

/**
 * Raised by the unit of work when the commit hits the provider's external id: a
 * concurrent submission on another wallet won the race. It is a conflict.
 */
export class DuplicateExternalIdError extends Error {
  override readonly name = 'DuplicateExternalIdError';
}

/** The wallet a submission names does not exist; no transaction is created. */
export class SubmissionWalletNotFoundError extends Error {
  override readonly name = 'SubmissionWalletNotFoundError';

  constructor(walletId: string) {
    super(`wallet not found: ${walletId}`);
  }
}
