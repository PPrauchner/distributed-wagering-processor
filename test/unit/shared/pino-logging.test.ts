/**
 * The pino logging: every line carries the fields of its context, which stays
 * apart between concurrent contexts, and money, balance and body fields are
 * redacted even when someone logs them.
 *
 * @packageDocumentation
 */
import { describe, expect, test } from 'bun:test';
import {
  LogContextStore,
  PinoContextLog,
  PinoLoggerService,
  createPinoLogger,
} from '../../../src/shared/infrastructure/pino-logging.ts';

function capture(): { lines: Record<string, unknown>[]; store: LogContextStore; log: PinoContextLog; nest: PinoLoggerService } {
  const lines: Record<string, unknown>[] = [];
  const store = new LogContextStore();
  const logger = createPinoLogger(store, { write: (line: string) => lines.push(JSON.parse(line)) });
  return { lines, store, log: new PinoContextLog(logger, store), nest: new PinoLoggerService(logger) };
}

describe('pino logging', () => {
  test('a line carries its context, enriched along the way', () => {
    const { lines, store, log } = capture();

    store.run({ correlationId: 'corr-1' }, () => {
      log.enrich({ transactionId: 'tx-1', walletId: 'wallet-1' });
      log.info('settled', { kind: 'BET' });
    });

    expect(lines).toEqual([
      expect.objectContaining({
        level: 30,
        msg: 'settled',
        correlationId: 'corr-1',
        transactionId: 'tx-1',
        walletId: 'wallet-1',
        kind: 'BET',
      }),
    ]);
  });

  test('a context opened by the log itself carries the queue message id', async () => {
    const { lines, log } = capture();

    await log.inContext({ messageId: 'msg-1' }, async () => {
      log.enrich({ transactionId: 'tx-1' });
      log.info('settled');
    });
    log.info('outside');

    expect(lines[0]).toEqual(expect.objectContaining({ messageId: 'msg-1', transactionId: 'tx-1' }));
    expect(lines[1]).not.toHaveProperty('messageId');
  });

  test('an alert is a warn line, with its context', () => {
    const { lines, store, log } = capture();

    store.run({ transactionId: 'tx-1' }, () => log.warn('pending reference failed', { failureCode: 'INFRA_UNEXPECTED' }));

    expect(lines).toEqual([
      expect.objectContaining({
        level: 40,
        msg: 'pending reference failed',
        transactionId: 'tx-1',
        failureCode: 'INFRA_UNEXPECTED',
      }),
    ]);
  });

  test('concurrent contexts do not share fields', async () => {
    const { lines, store, log } = capture();

    await Promise.all(
      ['a', 'b'].map((id) =>
        store.run({ correlationId: id }, async () => {
          await Bun.sleep(1);
          log.enrich({ transactionId: `tx-${id}` });
          await Bun.sleep(1);
          log.info('settled');
        }),
      ),
    );

    expect(lines.map(({ correlationId, transactionId }) => [correlationId, transactionId]).sort()).toEqual([
      ['a', 'tx-a'],
      ['b', 'tx-b'],
    ]);
  });

  test('enriching outside any context is ignored', () => {
    const { lines, log } = capture();

    log.enrich({ transactionId: 'tx-1' });
    log.info('outside');

    expect(lines[0]).not.toHaveProperty('transactionId');
  });

  test('money, balances and bodies are redacted', () => {
    const { lines, nest } = capture();

    nest.log({ money: { amount: '123.45', currency: 'BRL' }, balance: '987.65', body: { amount: '1.00' } }, 'Test');

    const raw = JSON.stringify(lines);
    expect(raw).not.toContain('123.45');
    expect(raw).not.toContain('987.65');
    expect(raw).not.toContain('1.00');
    expect(lines[0]).toMatchObject({ context: 'Test' });
  });

  test('money nested at any depth is redacted', () => {
    const { lines, nest } = capture();

    nest.log({ data: { transaction: { money: { amount: '123.45' } } }, items: [{ balance: '987.65' }] }, 'Test');
    nest.warn({ result: { wallet: { storedBalance: '555.55' } } }, 'Test');

    const raw = JSON.stringify(lines);
    expect(raw).not.toContain('123.45');
    expect(raw).not.toContain('987.65');
    expect(raw).not.toContain('555.55');
    expect(lines[0]).toMatchObject({ data: { data: { transaction: { money: '[redacted]' } } } });
  });

  test("Nest's errors are logged by name and failure code, never by message", () => {
    const { lines, nest } = capture();
    const error = Object.assign(new Error('insert into ledger values (123.45)', { cause: new Error('987.65') }), {
      failureCode: 'INFRA_UNEXPECTED',
    });

    nest.error(error, 'HttpErrorFilter');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 50, msg: 'Error', error: 'Error', failureCode: 'INFRA_UNEXPECTED', context: 'HttpErrorFilter' });
    const raw = JSON.stringify(lines);
    expect(raw).not.toContain('123.45');
    expect(raw).not.toContain('987.65');
  });

  test("an error's stack goes only to the debug level", () => {
    const debugLines: Record<string, unknown>[] = [];
    const logger = createPinoLogger(new LogContextStore(), { write: (line: string) => debugLines.push(JSON.parse(line)) });
    logger.level = 'debug';

    new PinoLoggerService(logger).error(new TypeError('a bug'), 'Test');

    expect(debugLines.map((line) => line.level)).toEqual([50, 20]);
    expect(debugLines[0]).not.toHaveProperty('stack');
    expect(debugLines[1]).toHaveProperty('stack');
  });

  test("Nest's string errors keep their stack out of the error line", () => {
    const { lines, nest } = capture();

    nest.error('handler failed', 'Error: secret 123.45\n    at x', 'ExceptionsHandler');

    expect(lines).toEqual([expect.objectContaining({ level: 50, msg: 'handler failed', context: 'ExceptionsHandler' })]);
    expect(JSON.stringify(lines)).not.toContain('123.45');
  });
});
