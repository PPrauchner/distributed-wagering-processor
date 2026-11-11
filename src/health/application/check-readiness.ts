/**
 * `CheckReadiness`: runs every readiness probe at once, each bounded by its own
 * timeout, and says whether the instance can take traffic — all probes passed —
 * and which one failed (`ARCHITECTURE.md` § Observabilidade).
 *
 * @packageDocumentation
 */

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
}

export class CheckReadiness {
  constructor(
    private readonly probes: readonly ReadinessProbe[],
    private readonly timeoutMs: number,
  ) {}

  async execute(): Promise<ReadinessReport> {
    const statuses = await Promise.all(this.probes.map((probe) => this.statusOf(probe)));
    const checks = Object.fromEntries(this.probes.map((probe, index) => [probe.name, statuses[index]!]));
    return { ready: statuses.every((status) => status === 'up'), checks };
  }

  private async statusOf(probe: ReadinessProbe): Promise<ProbeStatus> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`${probe.name} timed out`));
      }, this.timeoutMs);
    });
    try {
      await Promise.race([probe.check(controller.signal), timeout]);
      return 'up';
    } catch {
      return 'down';
    } finally {
      clearTimeout(timer);
    }
  }
}
