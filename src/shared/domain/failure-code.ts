/**
 * `FailureCode`: the closed set of stable, machine-readable reasons of a
 * rejection, a refused submission or a failure (`ARCHITECTURE.md` § Códigos de
 * falha). The provider decides from the code alone whether to resend, fix the
 * payload or give up.
 *
 * @packageDocumentation
 */

export enum FailureCode {
  // Rejections (422): the transaction exists and was refused by a business rule.
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  ReferenceKindNotAllowed = 'REFERENCE_KIND_NOT_ALLOWED',
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  BalanceLimitExceeded = 'BALANCE_LIMIT_EXCEEDED',
  // Refused submissions: no transaction is created.
  InvalidPayload = 'INVALID_PAYLOAD',
  MissingIdempotencyKey = 'MISSING_IDEMPOTENCY_KEY',
  InternalKindNotAllowed = 'INTERNAL_KIND_NOT_ALLOWED',
  InvalidCursor = 'INVALID_CURSOR',
  IdempotencyConflict = 'IDEMPOTENCY_CONFLICT',
  ExternalIdConflict = 'EXTERNAL_ID_CONFLICT',
  WalletAlreadyExists = 'WALLET_ALREADY_EXISTS',
  WalletNotFound = 'WALLET_NOT_FOUND',
  MessageIdConflict = 'MESSAGE_ID_CONFLICT',
  ProviderIdentityMismatch = 'PROVIDER_IDENTITY_MISMATCH',
  // Queue only, no outcome: transient failures out of receives; the key stays free.
  InfraRetriesExhausted = 'INFRA_RETRIES_EXHAUSTED',
  // Queries.
  NotFound = 'NOT_FOUND',
  // Failures (500).
  InfraInvariantViolation = 'INFRA_INVARIANT_VIOLATION',
  InfraUnexpected = 'INFRA_UNEXPECTED',
  // Transient (503): resend with the same key.
  TransientLockTimeout = 'TRANSIENT_LOCK_TIMEOUT',
  TransientUnavailable = 'TRANSIENT_UNAVAILABLE',
}
