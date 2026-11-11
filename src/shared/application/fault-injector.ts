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
  /**
   * The queue consumer dies after the outcome committed, before the `ack`:
   * the message reappears once its visibility expires.
   */
  CrashAfterCommit = 'crash-after-commit',
  /**
   * The outbox publisher dies after the send, before `published_at`: the lease
   * expires and another instance resends the same `eventId`.
   */
  CrashAfterSend = 'crash-after-send',
}

/** The process "died" at a crash point: what came after it never ran. */
export class SimulatedCrashError extends Error {
  override readonly name = 'SimulatedCrashError';

  constructor(readonly point: FaultPoint) {
    super(`simulated crash at ${point}`);
  }
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
