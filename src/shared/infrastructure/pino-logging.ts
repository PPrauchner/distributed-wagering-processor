/**
 * Structured logs over pino: one JSON line per log, with the fields of the
 * current context — an `AsyncLocalStorage` opened per HTTP request or unit of
 * work outside HTTP — mixed into every line. The same logger serves Nest, as
 * its `LoggerService`, and the use cases, as their `ContextLog`. Money, balance
 * and body fields are redacted, a safety net under the rule of logging only
 * identifiers.
 *
 * @packageDocumentation
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { LoggerService } from '@nestjs/common';
import pino, { type DestinationStream, type Logger } from 'pino';
import type { ContextLog, LogContextFields, LogDetails } from '../application/context-log.ts';

const REDACTED_KEYS = [
  'money',
  'amount',
  'balance',
  'balanceAfter',
  'balanceBefore',
  'initialBalance',
  'storedBalance',
  'calculatedBalance',
  'difference',
  'body',
  'payload',
];
const REDACT_PATHS = REDACTED_KEYS.flatMap((key) => [key, `*.${key}`]);

/** The context of the current request or unit of work, carried across its awaits. */
export class LogContextStore {
  private readonly storage = new AsyncLocalStorage<LogContextFields>();

  /**
   * @param fields - The context's first fields.
   * @param work - Runs inside the new context.
   * @returns What `work` returns.
   */
  run<T>(fields: LogContextFields, work: () => T): T {
    return this.storage.run({ ...fields }, work);
  }

  /** The current context's fields; empty outside any. */
  get(): LogContextFields {
    return this.storage.getStore() ?? {};
  }

  /** Adds fields to the current context; ignored outside any. */
  enrich(fields: LogContextFields): void {
    const store = this.storage.getStore();
    if (store === undefined) return;
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) Reflect.set(store, key, value);
    }
  }
}

/**
 * @param context - Whose fields every line carries.
 * @param destination - Where the lines go; stdout by default.
 * @returns The pino logger.
 */
export function createPinoLogger(context: LogContextStore, destination?: DestinationStream): Logger {
  return pino(
    {
      level: 'info',
      base: undefined,
      timestamp: pino.stdTimeFunctions.isoTime,
      mixin: () => ({ ...context.get() }),
      redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    },
    destination,
  );
}

/** Nest's `LoggerService` over pino; Nest's context goes in the `context` field. */
export class PinoLoggerService implements LoggerService {
  constructor(private readonly logger: Logger) {}

  log(message: unknown, ...params: unknown[]): void {
    this.write('info', message, params);
  }

  error(message: unknown, ...params: unknown[]): void {
    this.write('error', message, params);
  }

  warn(message: unknown, ...params: unknown[]): void {
    this.write('warn', message, params);
  }

  debug(message: unknown, ...params: unknown[]): void {
    this.write('debug', message, params);
  }

  verbose(message: unknown, ...params: unknown[]): void {
    this.write('trace', message, params);
  }

  fatal(message: unknown, ...params: unknown[]): void {
    this.write('fatal', message, params);
  }

  // Nest passes the context last, and an error's stack before it.
  private write(level: pino.Level, message: unknown, params: unknown[]): void {
    const context = params.length > 0 && typeof params.at(-1) === 'string' ? (params.at(-1) as string) : undefined;
    if (message instanceof Error) {
      this.logger[level]({ context, err: message }, message.message);
      return;
    }
    const stack = level === 'error' && params.length > 1 ? params[0] : undefined;
    if (typeof message === 'string') this.logger[level]({ context, stack }, message);
    else this.logger[level]({ context, stack, data: message });
  }
}

/** The use cases' `ContextLog` over pino and the context store. */
export class PinoContextLog implements ContextLog {
  constructor(
    private readonly logger: Logger,
    private readonly context: LogContextStore,
  ) {}

  enrich(fields: LogContextFields): void {
    this.context.enrich(fields);
  }

  info(message: string, details: LogDetails = {}): void {
    this.logger.info(details, message);
  }
}
