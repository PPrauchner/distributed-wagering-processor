/**
 * Concurrency scenario 6 of §13, with real app processes: a publisher killed
 * between the send and `published_at` (`crash-after-send`), then two
 * publishers at once over the same outbox, while new events are written.
 * Every confirmed event reaches the events queue, none is lost, and what
 * arrives twice carries the same `eventId`. Ends checking the ledger
 * invariant of every wallet it touched.
 *
 * @packageDocumentation
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { killAllInstances, startInstance } from './support/app-processes.ts';
import {
  createScenarioQueues,
  deleteScenarioQueues,
  receiveEvents,
  type ReceivedEvent,
  type ScenarioQueues,
} from './support/queues.ts';
import { waitUntil } from './support/wait-until.ts';
import {
  createWallet,
  expectWalletsConsistent,
  sql,
  submitUntilTerminal,
  transactionOn,
  type TestWallet,
} from './support/wagering.ts';

afterEach(killAllInstances);
afterAll(deleteScenarioQueues);

function publisherOn(queues: ScenarioQueues, faults: string[] = []) {
  return startInstance({
    inputQueue: queues.input.name,
    dlq: queues.dlq.name,
    eventsQueue: queues.events.name,
    publisher: true,
    faults,
  });
}

async function outboxOf(wallets: readonly TestWallet[]): Promise<{ id: string; published: boolean }[]> {
  return [
    ...(await sql`
      select id::text, published_at is not null as published
        from outbox_messages where wallet_id in ${sql(wallets.map((wallet) => wallet.id))}
    `),
  ];
}

describe('6. publishers over the same outbox', () => {
  test('one killed after the send, then two at once: every event arrives, none is lost, duplicates share the eventId', async () => {
    const queues = await createScenarioQueues();
    const received: ReceivedEvent[] = [];
    const receivedIds = () => new Set(received.map((event) => event.eventId));

    // A publisher that sends and dies before recording the publication.
    const dying = await publisherOn(queues, ['crash-after-send']);
    const first = await createWallet(dying.url, '100.00');
    await submitUntilTerminal(dying.url, transactionOn(first, 'BET'));
    const crashed = (await outboxOf([first])).map((row) => row.id);
    await waitUntil(
      async () => {
        received.push(...(await receiveEvents(queues.events)));
        return crashed.every((id) => receivedIds().has(id)) ? true : undefined;
      },
      60_000,
      'the dying publisher sent its events',
    );
    await dying.kill();
    expect((await outboxOf([first])).some((row) => row.published)).toBe(false);

    // Two publishers at once, with new events written meanwhile.
    const publishers = await Promise.all([publisherOn(queues), publisherOn(queues)]);
    const others = await Promise.all([1, 2, 3].map((index) => createWallet(publishers[index % 2]!.url, '100.00')));
    await Promise.all(
      others.flatMap((wallet, index) =>
        [1, 2, 3, 4].map(() => submitUntilTerminal(publishers[index % 2]!.url, transactionOn(wallet, 'BET'))),
      ),
    );
    const wallets = [first, ...others];
    await waitUntil(
      async () => ((await outboxOf(wallets)).every((row) => row.published) ? true : undefined),
      60_000,
      'every outbox row published',
    );
    const confirmed = (await outboxOf(wallets)).map((row) => row.id);
    await waitUntil(
      async () => {
        received.push(...(await receiveEvents(queues.events)));
        return confirmed.every((id) => receivedIds().has(id)) ? true : undefined;
      },
      60_000,
      'every confirmed event received',
    );

    expect(confirmed.length).toBeGreaterThan(crashed.length);
    for (const event of received) expect(event.deduplicationId).toBe(event.eventId);
    const known: { id: string }[] = await sql`select id::text from outbox_messages where id in ${sql([...receivedIds()])}`;
    expect(known).toHaveLength(receivedIds().size);
    await expectWalletsConsistent(wallets.map((wallet) => wallet.id));
  }, 120_000);
});
