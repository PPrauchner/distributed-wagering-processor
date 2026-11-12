/**
 * Concurrency scenario 7 of §13, with real app processes: `REFUND` and
 * `ROLLBACK` delivered before their reference, by HTTP and by the queue,
 * through two instances, with the reference sent concurrently with a resend of
 * the dependent. The dependent waits `PENDING_REFERENCE` and the worker
 * resolves it once the reference is processed: its effect happens once.
 * Ends checking the ledger invariant of every wallet it touched.
 *
 * @packageDocumentation
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { killAllInstances, startInstance } from './support/app-processes.ts';
import { createScenarioQueues, deleteScenarioQueues, drained, sendSubmission } from './support/queues.ts';
import { waitUntil } from '../support/wait-until.ts';
import {
  citing,
  createWallet,
  expectWalletsConsistent,
  ledgerEntries,
  queued,
  submitUntilTerminal,
  terminalTransactionOf,
  transactionOn,
  transactionsOf,
  walletState,
  type JsonObject,
} from './support/wagering.ts';

afterEach(killAllInstances);
afterAll(deleteScenarioQueues);

describe('7. REFUND or ROLLBACK delivered before its reference', () => {
  test('waits PENDING_REFERENCE, the worker resolves it after the reference, and its effect happens once', async () => {
    const queues = await createScenarioQueues();
    const [a, b] = await Promise.all(
      [1, 2].map(() =>
        startInstance({
          inputQueue: queues.input.name,
          dlq: queues.dlq.name,
          eventsQueue: queues.events.name,
          consumer: true,
          pendingReferencesWorker: true,
        }),
      ),
    );
    const wallets = await Promise.all(Array.from({ length: 6 }, () => createWallet(a!.url, '100.00')));
    const cases = wallets.map((wallet, index) => {
      const bet = transactionOn(wallet, 'BET');
      return { wallet, bet, dependent: citing(wallet, index < 3 ? 'REFUND' : 'ROLLBACK', bet), byQueue: index % 2 === 1 };
    });
    const submit = (data: JsonObject, byQueue: boolean, url: string) =>
      byQueue ? sendSubmission(queues.input, queued(data)) : submitUntilTerminal(url, data);

    // The dependents first, out of order.
    await Promise.all(cases.map(({ dependent, byQueue }) => submit(dependent, byQueue, a!.url)));
    await waitUntil(
      async () => {
        const rows = await Promise.all(cases.map(({ dependent }) => transactionsOf(dependent)));
        return rows.every((found) => found[0]?.status === 'PENDING_REFERENCE') ? true : undefined;
      },
      30_000,
      'every dependent pending its reference',
    );

    // The references, concurrently with a resend of each dependent through the other instance.
    await Promise.all(
      cases.flatMap(({ bet, dependent, byQueue }) => [submit(bet, byQueue, b!.url), submit(dependent, !byQueue, b!.url)]),
    );
    await waitUntil(
      async () =>
        (await Promise.all(cases.map(({ dependent }) => terminalTransactionOf(dependent)))).every(Boolean)
          ? true
          : undefined,
      60_000,
      'every dependent resolved',
    );
    await waitUntil(() => drained(queues.input), 30_000, 'input queue drained');

    for (const { wallet, bet, dependent } of cases) {
      expect(await transactionsOf(bet)).toMatchObject([{ status: 'PROCESSED' }]);
      expect(await transactionsOf(dependent)).toMatchObject([{ status: 'PROCESSED' }]);
      expect(await walletState(wallet.id)).toEqual({ balance: '100.00', version: 3 });
      expect((await ledgerEntries(wallet.id)).total).toBe(3);
    }
    await expectWalletsConsistent(wallets.map((wallet) => wallet.id));
  }, 120_000);
});
