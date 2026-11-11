/**
 * `FaultInjector` for the crash points outside any unit of work: an enabled
 * point "kills" the process there, so what would come next never runs. With
 * no point enabled — the default — it does nothing.
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

export class CrashFaultInjector implements FaultInjector {
  private readonly enabled: ReadonlySet<FaultPoint>;

  constructor(enabled: readonly FaultPoint[]) {
    this.enabled = new Set(enabled);
  }

  async inject(point: FaultPoint, _context: FaultContext = {}): Promise<void> {
    if (this.enabled.has(point) && CRASH_POINTS.has(point)) throw new SimulatedCrashError(point);
  }
}
