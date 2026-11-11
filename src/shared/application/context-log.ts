/**
 * `ContextLog` port: how a use case logs, without depending on a logging
 * library. Lines carry the context of the request or unit of work they run in
 * — the channel opens it, the use case enriches it as it learns the ids — and
 * only identifiers and codes: never money, balances or payloads
 * (`ARCHITECTURE.md` § Observabilidade).
 *
 * @packageDocumentation
 */

/** Injection token of the context log implementation. */
export const CONTEXT_LOG = Symbol('ContextLog');

/** The identifiers every line of a request or unit of work carries. */
export interface LogContextFields {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

/** What a line may add: kinds, statuses, codes, flags — never values. */
export type LogDetails = Record<string, string | number | boolean | undefined>;

export interface ContextLog {
  /** Adds fields to the current context: every later line in it carries them. */
  enrich(fields: LogContextFields): void;
  info(message: string, details?: LogDetails): void;
}
