/**
 * Concurrency scenarios 1 to 3 of §13, by real parallel HTTP requests to a
 * real app process: the same bet 50 times, the race of §8 for the balance of
 * one wallet — both bets made to wait on the wallet lock before it goes —, and distinct wallets processed in parallel with no global lock.
 * Every scenario ends checking the ledger invariant of every wallet it touched.
 *
 * @packageDocumentation
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { killAllInstances, startInstance, type AppInstance } from './support/app-processes.ts';
import { createScenarioQueues, deleteScenarioQueues } from './support/queues.ts';
import { waitUntil } from './support/wait-until.ts';
import {
  createWallet,
  expectWalletsConsistent,
  keyOf,
  ledgerEntries,
  sql,
  submitUntilTerminal,
  transactionOn,
  transactionsOf,
  walletState,
  type JsonObject,
} from './support/wagering.ts';

let app: AppInstance;

beforeAll(async () => {
  const queues = await createScenarioQueues();
  app = await startInstance({ inputQueue: queues.input.name, dlq: queues.dlq.name, eventsQueue: queues.events.name });
});

afterAll(async () => {
  await killAllInstances();
  await deleteScenarioQueues();
});

describe('1. the same bet sent 50 times in parallel', () => {
  test('one transaction and one debit; every answer is the original, the repetitions with idempotentReplay', async () => {
    const wallet = await createWallet(app.url, '100.00');
    const bet = transactionOn(wallet, 'BET');

    const answers = await Promise.all(Array.from({ length: 50 }, () => submitUntilTerminal(app.url, bet)));

    const originals = answers.filter((answer) => answer.body.idempotentReplay === false);
    expect(originals).toHaveLength(1);
    const [original] = originals;
    expect(original!.status).toBe(200);
    for (const answer of answers) {
      expect(answer.status).toBe(original!.status);
      expect(answer.body).toEqual({ ...original!.body, idempotentReplay: answer !== original });
    }
    expect(await transactionsOf(bet)).toHaveLength(1);
    expect(await walletState(wallet.id)).toEqual({ balance: '75.00', version: 2 });
    expect((await ledgerEntries(wallet.id)).debits).toBe(1);
    await expectWalletsConsistent([wallet.id]);
  }, 60_000);
});

describe('2. the race of §8: two bets of 80.00 at once on 100.00', () => {
  test('one PROCESSED, one REJECTED INSUFFICIENT_FUNDS, 20.00 left, one debit — and resending both duplicates nothing', async () => {
    const wallet = await createWallet(app.url, '100.00');
    const bets = [1, 2].map(() => transactionOn(wallet, 'BET', { money: { amount: '80.00', currency: 'BRL' } }));

    // Both bets meet the wallet locked by another session, so they overlap for sure;
    // the lock goes only once both wait on it, well within the 2 s lock_timeout.
    let release!: () => void;
    const lock = await holdWalletLock(wallet.id, new Promise((resolve) => (release = resolve)));
    const submitted = Promise.all(bets.map((bet) => submitUntilTerminal(app.url, bet)));
    await waitUntil(
      async () => ((await sessionsWaitingOnWalletLock()) >= 2 ? true : undefined),
      1_500,
      'both bets waiting on the wallet lock',
    ).finally(release);
    await lock.released;
    const answers = await submitted;

    expect(answers.map((answer) => answer.body.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
    expect(answers.find((answer) => answer.body.status === 'REJECTED')!.body.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(await walletState(wallet.id)).toEqual({ balance: '20.00', version: 2 });
    expect((await ledgerEntries(wallet.id)).debits).toBe(1);

    const resent = await Promise.all(bets.map((bet) => submitUntilTerminal(app.url, bet)));

    expect(resent.map((answer) => answer.body.idempotentReplay)).toEqual([true, true]);
    expect(resent.map((answer) => answer.body.status)).toEqual(answers.map((answer) => answer.body.status));
    expect(await walletState(wallet.id)).toEqual({ balance: '20.00', version: 2 });
    expect((await ledgerEntries(wallet.id)).debits).toBe(1);
    await expectWalletsConsistent([wallet.id]);
  }, 60_000);
});

describe('3. distinct wallets in parallel', () => {
  test('bets on ten wallets at once are all processed', async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => createWallet(app.url, '100.00')));
    const bets = wallets.flatMap((wallet) => [1, 2, 3].map(() => transactionOn(wallet, 'BET')));

    const answers = await Promise.all(bets.map((bet) => submitUntilTerminal(app.url, bet)));

    expect(answers.every((answer) => answer.body.status === 'PROCESSED')).toBe(true);
    for (const wallet of wallets) expect(await walletState(wallet.id)).toEqual({ balance: '25.00', version: 4 });
    await expectWalletsConsistent(wallets.map((wallet) => wallet.id));
  }, 60_000);

  test('with wallet A locked by another session, bets on wallet B complete meanwhile, with no lock timeout', async () => {
    const [a, b] = await Promise.all([createWallet(app.url, '100.00'), createWallet(app.url, '100.00')]);
    let release!: () => void;
    const lock = await holdWalletLock(a.id, new Promise((resolve) => (release = resolve)));

    let betOnAEnded = false;
    const betOnA = submitUntilTerminal(app.url, transactionOn(a, 'BET')).finally(() => (betOnAEnded = true));
    const answersOnB = await Promise.all(
      [1, 2, 3, 4, 5].map(() => submitOnce(app.url, transactionOn(b, 'BET', { money: { amount: '10.00', currency: 'BRL' } }))),
    );
    const bEndedWhileALocked = !betOnAEnded;
    release();
    await lock.released;
    const answerOnA = await betOnA;

    expect(bEndedWhileALocked).toBe(true);
    expect(answersOnB.map((answer) => answer.status)).toEqual([200, 200, 200, 200, 200]);
    expect(answersOnB.some((answer) => answer.body.failureCode === 'TRANSIENT_LOCK_TIMEOUT')).toBe(false);
    expect(answerOnA.body.status).toBe('PROCESSED');
    expect(await walletState(b.id)).toEqual({ balance: '50.00', version: 6 });
    expect(await walletState(a.id)).toEqual({ balance: '75.00', version: 2 });
    await expectWalletsConsistent([a.id, b.id]);
  }, 60_000);
});

/** One request, no resend: a 503 here is an answer to assert on. */
async function submitOnce(baseUrl: string, data: JsonObject): Promise<{ status: number; body: JsonObject }> {
  const response = await fetch(`${baseUrl}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': keyOf(data) },
    body: JSON.stringify(data),
  });
  return { status: response.status, body: (await response.json()) as JsonObject };
}

/**
 * @returns How many sessions of the test database hold a lock request not
 *   granted in `pg_locks` while running the use case's wallet lock.
 */
async function sessionsWaitingOnWalletLock(): Promise<number> {
  const [row] = await sql`
    select count(distinct l.pid)::int as n
      from pg_locks l join pg_stat_activity a on a.pid = l.pid
     where not l.granted and a.datname = current_database()
       and a.query ~* 'from "wallets".*for update'
  `;
  return row.n;
}

/**
 * Holds the wallet's row lock — the one the use case waits for — in another
 * session, until `release` resolves.
 *
 * @returns Once the lock is held: the session's end.
 */
async function holdWalletLock(walletId: string, release: Promise<void>): Promise<{ released: Promise<void> }> {
  let held!: () => void;
  const locked = new Promise<void>((resolve) => (held = resolve));
  const session = sql.begin(async (tx) => {
    await tx`select id from wallets where id = ${walletId} for no key update`;
    held();
    await release;
  });
  await locked;
  return { released: session.then(() => undefined) };
}
