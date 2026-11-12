/**
 * Captures what goes through Nest's `Logger` during a test, as text, so a test
 * can check that a log never carries an error's message.
 *
 * @packageDocumentation
 */
import { ConsoleLogger, Logger, type LoggerService } from '@nestjs/common';

/**
 * @param work - Runs while Nest's logs are captured.
 * @returns Every line logged during `work`, its arguments serialized.
 */
export async function captureNestLogs(work: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const record = (...args: unknown[]): void => {
    lines.push(args.map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message} ${String(arg.cause)}` : String(arg))).join(' '));
  };
  const capture: LoggerService = { log: record, error: record, warn: record, debug: record, verbose: record, fatal: record };
  Logger.overrideLogger(capture);
  try {
    await work();
  } finally {
    Logger.overrideLogger(new ConsoleLogger());
  }
  return lines;
}
