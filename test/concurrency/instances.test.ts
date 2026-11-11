/**
 * Concurrency scenarios 4 and 5 of §13, with real app processes: three
 * instances over the same database and queues under load by HTTP and by the
 * input queue at once, on a few hot wallets; and a worker killed between the
 * commit and the `ack`, whose message another instance gets again. Every
 * scenario ends checking the ledger invariant of every wallet it touched.
 *
 * @packageDocumentation
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { killAllInstances, startInstance } from './support/app-processes.ts';
import {
  createScenarioQueues,
  deleteScenarioQueues,
  drained,
  messagesLeft,
  sendSubmission,
  type ScenarioQueues,
} from './support/queues.ts';
import { waitUntil } from './support/wait-until.ts';
import {
  createWallet,
  expectWalletsConsistent,
  queued,
  sql,
  submitUntilTerminal,
  terminalTransactionOf,
  transactionOn,
  transactionsOf,
  walletState,
  type JsonObject,
} from './support/wagering.ts';

const ONE = { amount: '1.00', currency: 'BRL' };

afterEach(killAllInstances);
afterAll(deleteScenarioQueues);

function instanceOn(queues: ScenarioQueues, faults: string[] = []) {
  return startInstance({
    inputQueue: queues.input.name,
    dlq: queues.dlq.name,
    eventsQueue: queues.events.name,
    consumer: true,
    publisher: true,
    pendingReferencesWorker: true,
    faults,
  });
}

/** The balance the wallet's processed transactions add up to: no lost update leaves it apart from the stored one. */
async function balanceOfTransactions(walletId: string): Promise<string> {
  const [row] = await sql`
    select coalesce(sum(case when kind = 'BET' then -amount else amount end), 0)::numeric(19, 2)::text as balance
      from wager_transactions
     where wallet_id = ${walletId} and status = 'PROCESSED' and kind in ('OPENING', 'BET', 'WIN')
  `;
  return row.balance;
}

async function inboxDuplicates(url: string): Promise<number> {
  const text = await (await fetch(`${url}/metrics`)).text();
  const line = text.split('\n').find((row) => row.startsWith('inbox_duplicates_total '));
  return Number(line?.split(' ')[1] ?? 0);
}

describe('4. three instances at once over the same database and queues', () => {
  test('load by HTTP and by the queue on hot wallets: no lost update, no negative balance, one entry per moving transaction', async () => {
    const queues = await createScenarioQueues();
    const instances = await Promise.all([1, 2, 3].map(() => instanceOn(queues)));
    const wallets = await Promise.all([1, 2, 3].map(() => createWallet(instances[0]!.url, '50.00')));
    const byHttp = wallets.flatMap((wallet) => [
      ...Array.from({ length: 30 }, () => transactionOn(wallet, 'BET', { money: ONE })),
      ...Array.from({ length: 5 }, () => transactionOn(wallet, 'WIN', { money: ONE })),
    ]);
    const byQueue = wallets.flatMap((wallet) => Array.from({ length: 30 }, () => transactionOn(wallet, 'BET', { money: ONE })));

    const [answers] = await Promise.all([
      Promise.all(byHttp.map((data, index) => submitUntilTerminal(instances[index % 3]!.url, data))),
      Promise.all(byQueue.map((data) => sendSubmission(queues.input, queued(data)))),
    ]);
    await waitUntil(
      async () => ((await Promise.all(byQueue.map(terminalTransactionOf))).every(Boolean) ? true : undefined),
      90_000,
      'every queued submission settled',
    );
    await waitUntil(() => drained(queues.input), 30_000, 'input queue drained');

    expect(answers.every((answer) => ['PROCESSED', 'REJECTED'].includes(answer.body.status as string))).toBe(true);
    for (const data of [...byHttp, ...byQueue]) {
      const rows = await transactionsOf(data);
      expect(rows).toHaveLength(1);
      expect(['PROCESSED', 'REJECTED', 'FAILED']).toContain(rows[0]!.status);
    }
    for (const wallet of wallets) {
      const { balance } = await walletState(wallet.id);
      expect(Number(balance)).toBeGreaterThanOrEqual(0);
      expect(balance).toBe(await balanceOfTransactions(wallet.id));
    }
    await expectWalletsConsistent(wallets.map((wallet) => wallet.id));
  }, 120_000);
});

describe('5. a worker killed after the commit, before the ack', () => {
  test('another instance gets the message again: the inbox recognizes it, no second effect, and it is acknowledged', async () => {
    const queues = await createScenarioQueues();
    const dying = await instanceOn(queues, ['crash-after-commit']);
    const wallet = await createWallet(dying.url, '100.00');
    const bet: JsonObject = transactionOn(wallet, 'BET');

    await sendSubmission(queues.input, queued(bet));
    await waitUntil(() => terminalTransactionOf(bet), 30_000, 'the bet committed');
    await dying.kill();
    expect(dying.process.exitCode === 0).toBe(false);
    expect(await messagesLeft(queues.input)).toBe(1);
    const afterCommit = await walletState(wallet.id);

    const survivor = await instanceOn(queues);
    await waitUntil(() => drained(queues.input), 30_000, 'input queue drained');

    expect(await inboxDuplicates(survivor.url)).toBe(1);
    expect(await transactionsOf(bet)).toMatchObject([{ status: 'PROCESSED' }]);
    expect(afterCommit).toEqual({ balance: '75.00', version: 2 });
    expect(await walletState(wallet.id)).toEqual(afterCommit);
    await expectWalletsConsistent([wallet.id]);
  }, 60_000);
});
