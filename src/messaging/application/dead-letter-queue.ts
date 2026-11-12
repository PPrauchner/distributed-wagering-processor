/**
 * `DeadLetterQueue` port: where a consumer sends, explicitly, the message it
 * gives up on — a submission not admitted, a `FAILED` outcome, retries
 * exhausted —, with the `failureCode` that says why (`ARCHITECTURE.md` §
 * Consumidor). Implemented over SQS; nothing here knows the broker.
 *
 * @packageDocumentation
 */

/** A message given up on, as it goes to the DLQ. */
export interface DeadLetter {
  /** The original body, untouched. */
  body: string;
  /** The original string attributes, kept alongside the `failureCode`. */
  attributes: Readonly<Record<string, string>>;
  failureCode: string;
  /** Orders the DLQ: the wallet, when the body names one. */
  groupId: string;
  /**
   * Deduplicates resends of the same delivery — its queue message's id —,
   * never a new delivery of the same body, as a DLQ redrive is.
   */
  deduplicationId: string;
}

export interface DeadLetterQueue {
  /** Sends the message to the DLQ; resolves once the broker took it. */
  send(letter: DeadLetter): Promise<void>;
}

/** Injection token of the DLQ of the wager transactions. */
export const WAGER_TRANSACTIONS_DLQ = Symbol('WagerTransactionsDlq');
