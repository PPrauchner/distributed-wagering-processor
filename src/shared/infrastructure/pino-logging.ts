/**
 * Structured logs over pino: one JSON line per log, with the fields of the
 * current context — an `AsyncLocalStorage` opened per HTTP request or unit of
 * work outside HTTP — mixed into every line. The same logger serves Nest, as
 * its `LoggerService`, and the use cases, as their `ContextLog`. Money, balance
 * and body fields are redacted at any depth, a safety net under the rule of
 * logging only identifiers; an error is logged by name and failure code, its
 * stack only at the debug level.
 *
 * @packageDocumentation
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { LoggerService } from '@nestjs/common';
import pino, { type DestinationStream, type LevelWithSilent, type Logger } from 'pino';
import type { ContextLog, LogContextFields, LogDetails } from '../application/context-log.ts';
import { summarizeError } from '../application/error-summary.ts';

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
const REDACTED = new Set(REDACTED_KEYS);
const CENSOR = '[redacted]';

/**
 * A copy of the logged object with every redacted key masked, at any depth. An
 * object with a `toJSON` — `Money`, an event — is masked in the shape it would
 * be serialized in; `seen` holds only the current path, so a reference shared
 * by two branches is not taken for a cycle.
 */
function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value !== 'object' || value === null) return value;
  if (seen.has(value)) return '[circular]';
  const toJSON: unknown = Reflect.get(value, 'toJSON');
  if (typeof toJSON === 'function') {
    seen.add(value);
    const serialized = redact(toJSON.call(value), seen);
    seen.delete(value);
    return serialized;
  }
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    return value;
  }
  seen.add(value);
  const copy = Array.isArray(value)
    ? value.map((item) => redact(item, seen))
    : Object.fromEntries(
        Object.entries(value).map(([key, field]) => [key, REDACTED.has(key) ? CENSOR : redact(field, seen)]),
      );
  seen.delete(value);
  return copy;
}

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
 * @param level - The lowest level written; `silent` writes nothing.
 * @returns The pino logger.
 */
export function createPinoLogger(
  context: LogContextStore,
  destination?: DestinationStream,
  level: LevelWithSilent = 'info',
): Logger {
  return pino(
    {
      level,
      base: undefined,
      timestamp: pino.stdTimeFunctions.isoTime,
      mixin: () => ({ ...context.get() }),
      formatters: { log: (object) => redact(object) as Record<string, unknown> },
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

  // Nest passes the context last, and an error's stack before it. An error is
  // logged by name and failure code: its message, cause and stack may carry
  // values, so the stack goes only to the debug level.
  private write(level: pino.Level, message: unknown, params: unknown[]): void {
    const context = params.length > 0 && typeof params.at(-1) === 'string' ? (params.at(-1) as string) : undefined;
    if (message instanceof Error) {
      const summary = summarizeError(message);
      this.logger[level]({ context, ...summary }, summary.error);
      this.logger.debug({ context, stack: message.stack }, summary.error);
      return;
    }
    const stack = level === 'error' && params.length > 1 ? params[0] : undefined;
    if (typeof message === 'string') this.logger[level]({ context }, message);
    else this.logger[level]({ context, data: message });
    if (stack !== undefined) this.logger.debug({ context, stack }, 'stack of the error above');
  }
}

/** The use cases' `ContextLog` over pino and the context store. */
export class PinoContextLog implements ContextLog {
  constructor(
    private readonly logger: Logger,
    private readonly context: LogContextStore,
  ) {}

  inContext<T>(fields: LogContextFields, work: () => Promise<T>): Promise<T> {
    return this.context.run(fields, work);
  }

  enrich(fields: LogContextFields): void {
    this.context.enrich(fields);
  }

  info(message: string, details: LogDetails = {}): void {
    this.logger.info(details, message);
  }

  warn(message: string, details: LogDetails = {}): void {
    this.logger.warn(details, message);
  }
}
