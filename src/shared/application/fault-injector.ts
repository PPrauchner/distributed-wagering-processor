/**
 * `FaultInjector` port: named points where the tests make the service fail on
 * purpose, at the exact spot, with a real failure rather than a mock. No-op by
 * default; enabled only by the `FAULT_INJECTION` environment variable, never in
 * production (`ARCHITECTURE.md` § Testes).
 *
 * @packageDocumentation
 */

/** The named fault points; `FAULT_INJECTION` lists the enabled ones. */
export enum FaultPoint {
  /**
   * Inside the unit of work, before the commit: runs SQL that breaks a real
   * schema invariant, so the true error goes through the classifier.
   */
  InvariantViolationBeforeCommit = 'invariant-violation-before-commit',
  /** Reserved for the queue consumer: after the commit, before the `ack`. */
  CrashAfterCommit = 'crash-after-commit',
  /** Reserved for the outbox publisher: after the send, before `published_at`. */
  CrashAfterSend = 'crash-after-send',
}

/** What a fault point may need to know about where it fires. */
export interface FaultContext {
  transactionId?: string;
}

export interface FaultInjector {
  /**
   * Fires the fault at `point` when it is enabled; does nothing otherwise.
   *
   * @param point - The named point reached.
   * @param context - What the point acts on.
   */
  inject(point: FaultPoint, context: FaultContext): Promise<void>;
}

/** The fault injector a unit of work offers, bound to its SQL transaction. */
export interface FaultInjection {
  faults: FaultInjector;
}
