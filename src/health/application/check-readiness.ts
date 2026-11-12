/**
 * `CheckReadiness`: runs every readiness probe at once, each bounded by its own
 * timeout, and says whether the instance can take traffic — all probes passed —
 * and which one failed and why: the error's name, never its stack. A failed
 * probe is logged as a warning with the probe's name and the error's
 * (`ARCHITECTURE.md` § Observabilidade).
 *
 * @packageDocumentation
 */
import type { ContextLog } from '../../shared/application/context-log.ts';

/** One dependency the instance needs to serve: the database, a queue. */
export interface ReadinessProbe {
  readonly name: string;
  /**
   * @param signal - Aborted when the probe ran out of time.
   * @throws Whatever the dependency answered, if it is not usable.
   */
  check(signal: AbortSignal): Promise<void>;
}

export type ProbeStatus = 'up' | 'down';

export interface ReadinessReport {
  ready: boolean;
  checks: Record<string, ProbeStatus>;
  /** Why each probe that is down failed: the error's name. Empty when ready. */
  reasons: Record<string, string>;
}

/** Where failed probes are reported. */
export type ReadinessLog = Pick<ContextLog, 'warn'>;

/** The reason of a probe that ran out of time. */
const TIMEOUT_REASON = 'TimeoutError';

type ProbeOutcome = { status: 'up' } | { status: 'down'; reason: string };

export class CheckReadiness {
  constructor(
    private readonly probes: readonly ReadinessProbe[],
    private readonly timeoutMs: number,
    private readonly log: ReadinessLog,
  ) {}

  async execute(): Promise<ReadinessReport> {
    const outcomes = await Promise.all(this.probes.map((probe) => this.outcomeOf(probe)));
    const checks: Record<string, ProbeStatus> = {};
    const reasons: Record<string, string> = {};
    this.probes.forEach((probe, index) => {
      const outcome = outcomes[index]!;
      checks[probe.name] = outcome.status;
      if (outcome.status === 'down') reasons[probe.name] = outcome.reason;
    });
    return { ready: outcomes.every((outcome) => outcome.status === 'up'), checks, reasons };
  }

  private async outcomeOf(probe: ReadinessProbe): Promise<ProbeOutcome> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error(`${probe.name} timed out`));
      }, this.timeoutMs);
    });
    try {
      await Promise.race([probe.check(controller.signal), timeout]);
      return { status: 'up' };
    } catch (error) {
      const reason = timedOut ? TIMEOUT_REASON : errorName(error);
      this.log.warn('readiness probe failed', { probe: probe.name, error: reason });
      return { status: 'down', reason };
    } finally {
      clearTimeout(timer);
    }
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
