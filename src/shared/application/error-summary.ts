/**
 * What a log may say about an error: its name and, when it has one, its
 * failure code — never its message, cause or stack, which may carry SQL
 * parameters and, with them, money (§12 of the challenge: no sensitive data in
 * the logs).
 *
 * @packageDocumentation
 */

/** The loggable fields of an error. */
export interface ErrorSummary {
  /** The error's name; for a thrown non-error, its `typeof`. */
  error: string;
  failureCode?: string;
}

/**
 * @param error - Whatever was thrown.
 * @returns Its name and, when it carries one, its failure code.
 */
export function summarizeError(error: unknown): ErrorSummary {
  if (!(error instanceof Error)) return { error: typeof error };
  const failureCode: unknown = Reflect.get(error, 'failureCode');
  return typeof failureCode === 'string' ? { error: error.name, failureCode } : { error: error.name };
}

/**
 * @param error - Whatever was thrown.
 * @returns Its summary in one piece of text, e.g. `TransientFailureError (TRANSIENT_LOCK_TIMEOUT)`.
 */
export function describeError(error: unknown): string {
  const { error: name, failureCode } = summarizeError(error);
  return failureCode === undefined ? name : `${name} (${failureCode})`;
}
