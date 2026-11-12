/**
 * `FaultInjector` for the crash points outside any unit of work: an enabled
 * point "kills" the process there, so what would come next never runs. With
 * no point enabled — the default — it does nothing.
 *
 * How it dies is the composition root's choice: by default it throws
 * {@link SimulatedCrashError}, which is what the app run in process — by the
 * integration tests — can afford; the app run as a process of its own is given
 * a real death, `SIGKILL` to itself.
 *
 * @packageDocumentation
 */
import {
  FaultPoint,
  SimulatedCrashError,
  type FaultContext,
  type FaultInjector,
} from '../application/fault-injector.ts';

const CRASH_POINTS = new Set([FaultPoint.CrashAfterCommit, FaultPoint.CrashAfterSend]);

/** Ends the process at a crash point; never returns. */
export type Crash = (point: FaultPoint) => never;

/** The default crash: an exception, so whatever came next does not run. */
export const throwSimulatedCrash: Crash = (point) => {
  throw new SimulatedCrashError(point);
};

/** The crash of the app run as a process: killed at once, with no chance to finish anything. */
export const killProcess: Crash = (point) => {
  process.kill(process.pid, 'SIGKILL');
  // Unreachable once the signal lands; keeps the contract if it ever does not.
  throw new SimulatedCrashError(point);
};

export class CrashFaultInjector implements FaultInjector {
  private readonly enabled: ReadonlySet<FaultPoint>;

  /**
   * @param enabled - The fault points `FAULT_INJECTION` turned on.
   * @param crash - How the process dies at an enabled crash point.
   */
  constructor(
    enabled: readonly FaultPoint[],
    private readonly crash: Crash = throwSimulatedCrash,
  ) {
    this.enabled = new Set(enabled);
  }

  async inject(point: FaultPoint, _context: FaultContext = {}): Promise<void> {
    if (this.enabled.has(point) && CRASH_POINTS.has(point)) this.crash(point);
  }
}
