/**
 * Concurrency scenario 8 of §13, with real app processes: every instance is
 * killed with `SIGKILL` in the middle of a mixed load — bets and wins by HTTP,
 * bets and references by the queue, dependents before their reference —, then
 * new instances come up, the provider resends what got no answer, and the
 * suite waits for quiescence: nothing visible or in flight in the input queue
 * (what went to the DLQ left it), no transaction pending its reference and no
 * unpublished outbox row. Then every accepted submission has a terminal
 * outcome, no effect was duplicated, and the ledger invariant holds on every
 * wallet it touched.
 *
 * @packageDocumentation
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { killAllInstances, startInstance, type AppInstance } from './support/app-processes.ts';
import {
  createScenarioQueues,
  deleteScenarioQueues,
  drained,
  sendSubmission,
  type ScenarioQueues,
} from './support/queues.ts';
import { waitUntil } from './support/wait-until.ts';
import {
  citing,
  createWallet,
  expectWalletsConsistent,
  queued,
  sql,
  submitUntilTerminal,
  transactionOn,
  transactionsOf,
  walletState,
  type Answer,
  type JsonObject,
} from './support/wagering.ts';

const ONE = { amount: '1.00', currency: 'BRL' };
const TERMINAL = ['PROCESSED', 'REJECTED', 'FAILED'];

afterEach(killAllInstances);
afterAll(deleteScenarioQueues);

function instanceOn(queues: ScenarioQueues): Promise<AppInstance> {
  return startInstance({
    inputQueue: queues.input.name,
    dlq: queues.dlq.name,
    eventsQueue: queues.events.name,
    consumer: true,
    publisher: true,
    pendingReferencesWorker: true,
  });
}

async function settledCount(walletIds: readonly string[]): Promise<number> {
  const [row] = await sql`
    select count(*)::int as n from wager_transactions
     where wallet_id in ${sql(walletIds)} and kind <> 'OPENING' and status <> 'PENDING_REFERENCE'
  `;
  return row.n;
}

async function quiescent(queues: ScenarioQueues, walletIds: readonly string[]): Promise<true | undefined> {
  if (!(await drained(queues.input))) return undefined;
  const [row] = await sql`
    select (select count(*)::int from wager_transactions
             where wallet_id in ${sql(walletIds)} and status = 'PENDING_REFERENCE') as pending,
           (select count(*)::int from outbox_messages
             where wallet_id in ${sql(walletIds)} and published_at is null) as unpublished
  `;
  return row.pending === 0 && row.unpublished === 0 ? true : undefined;
}

describe('8. the service restarted', () => {
  test('SIGKILL of every instance mid-load, then a new start: quiescence, terminal outcomes, no duplicated effect', async () => {
    const queues = await createScenarioQueues();
    const before = await Promise.all([1, 2, 3].map(() => instanceOn(queues)));
    const wallets = await Promise.all([1, 2, 3, 4].map(() => createWallet(before[0]!.url, '100.00')));
    const walletIds = wallets.map((wallet) => wallet.id);
    const byHttp: JsonObject[] = [];
    const byQueue: JsonObject[] = [];
    for (const wallet of wallets) {
      for (let i = 0; i < 20; i += 1) byHttp.push(transactionOn(wallet, 'BET', { money: ONE }));
      for (let i = 0; i < 5; i += 1) byHttp.push(transactionOn(wallet, 'WIN', { money: ONE }));
      for (let i = 0; i < 20; i += 1) byQueue.push(transactionOn(wallet, 'BET', { money: ONE }));
      for (let i = 0; i < 3; i += 1) {
        const bet = transactionOn(wallet, 'BET', { money: ONE });
        byHttp.push(citing(wallet, i === 0 ? 'ROLLBACK' : 'REFUND', bet));
        byQueue.push(bet);
      }
    }

    // The load, cut short: every instance dies while it runs.
    const answers: Promise<Answer | undefined>[] = byHttp.map((data, index) =>
      submitUntilTerminal(before[index % 3]!.url, data).catch(() => undefined),
    );
    await Promise.all(byQueue.map((data) => sendSubmission(queues.input, queued(data))));
    await waitUntil(
      async () => ((await settledCount(walletIds)) >= 20 ? true : undefined),
      30_000,
      'the load under way',
    );
    await Promise.all(before.map((instance) => instance.kill()));
    const settledAtKill = await settledCount(walletIds);
    const firstAnswers = await Promise.all(answers);

    // A new start; the provider resends what got no answer, with the same key.
    const after = await Promise.all([1, 2].map(() => instanceOn(queues)));
    const resent = await Promise.all(
      byHttp.map((data, index) =>
        firstAnswers[index] === undefined ? submitUntilTerminal(after[index % 2]!.url, data) : undefined,
      ),
    );
    await waitUntil(() => quiescent(queues, walletIds), 90_000, 'quiescence');

    // The kill did cut the load short.
    expect(settledAtKill).toBeLessThan(byHttp.length + byQueue.length);
    // A resent dependent may answer 202 PENDING_REFERENCE; the worker settles it before quiescence.
    for (const answer of resent.filter(Boolean)) expect([...TERMINAL, 'PENDING_REFERENCE']).toContain(answer!.body.status as string);
    for (const data of [...byHttp, ...byQueue]) {
      const rows = await transactionsOf(data);
      expect(rows, String(data.externalTransactionId)).toHaveLength(1);
      expect(TERMINAL).toContain(rows[0]!.status);
    }
    for (const wallet of wallets) expect(Number((await walletState(wallet.id)).balance)).toBeGreaterThanOrEqual(0);
    await expectWalletsConsistent(walletIds);
  }, 180_000);
});
