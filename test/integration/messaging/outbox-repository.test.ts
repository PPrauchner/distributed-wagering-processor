/**
 * The outbox against a real PostgreSQL: messages are written by the unit of
 * work of the change — and vanish with its rollback —, claimed by lease with
 * `FOR UPDATE SKIP LOCKED` and the database clock, marked published and
 * rescheduled; `outbox_messages` holds its own constraints, proven by raw SQL.
 *
 * The test database is shared with the other test files, whose outcomes leave
 * pending messages too: claims are checked for this file's messages, never for
 * an exact set.
 *
 * @packageDocumentation
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../../../src/config.ts';
import { MikroOrmUnitOfWork } from '../../../src/database/mikro-orm-unit-of-work.ts';
import { createOrmConfig } from '../../../src/database/orm.config.ts';
import { OutboxMessage } from '../../../src/messaging/domain/outbox-message.ts';
import { waitUntil } from '../../support/wait-until.ts';

let orm: MikroORM;
let sql: SQL;
let unitOfWork: MikroOrmUnitOfWork;

beforeAll(async () => {
  const { databaseUrl } = loadConfig();
  orm = await MikroORM.init(createOrmConfig(databaseUrl));
  unitOfWork = new MikroOrmUnitOfWork(orm.em);
  sql = new SQL(databaseUrl);
});

afterAll(async () => {
  await orm?.close(true);
  await sql?.close();
});

function message(overrides: { nextAttemptAt?: Date } = {}): OutboxMessage {
  const id = Bun.randomUUIDv7();
  const walletId = Bun.randomUUIDv7();
  return OutboxMessage.rehydrate({
    id,
    aggregateId: walletId,
    eventType: 'WalletBalanceChanged',
    walletId,
    payload: { eventId: id, data: { walletId, money: { amount: '1.00', currency: 'BRL' } } },
    occurredAt: new Date(),
    attempts: 0,
    ...overrides,
  });
}

async function enqueue(...messages: OutboxMessage[]): Promise<void> {
  await unitOfWork.run(async ({ outbox }) => {
    for (const each of messages) outbox.add(each);
  });
}

async function row(id: string): Promise<Record<string, unknown> | undefined> {
  const [found] = await sql`
    select id, aggregate_id, event_type, wallet_id, payload, attempts, next_attempt_at, published_at
      from outbox_messages where id = ${id}
  `;
  return found;
}

/** Claims batches until every wanted message was claimed, or nothing is left. */
async function claimUntil(wanted: readonly string[], leaseMs = 30_000): Promise<OutboxMessage[]> {
  const claimed: OutboxMessage[] = [];
  for (;;) {
    const batch = await unitOfWork.run(({ outbox }) => outbox.claimDue(10, leaseMs));
    claimed.push(...batch);
    const ids = new Set(claimed.map((each) => each.id));
    if (batch.length === 0 || wanted.every((id) => ids.has(id))) return claimed;
  }
}

describe('writing in the unit of work', () => {
  test('a message added is committed with the change, payload as JSON', async () => {
    const added = message();

    await enqueue(added);

    expect(await row(added.id)).toEqual({
      id: added.id,
      aggregate_id: added.aggregateId,
      event_type: 'WalletBalanceChanged',
      wallet_id: added.walletId,
      payload: added.payload,
      attempts: 0,
      next_attempt_at: null,
      published_at: null,
    });
  });

  test('a unit of work that fails after writing the outbox leaves no row', async () => {
    const added = message();

    const failed = unitOfWork.run(async ({ outbox }) => {
      outbox.add(added);
      throw new Error('boom after the outbox');
    });

    await expect(failed).rejects.toThrow('boom after the outbox');
    expect(await row(added.id)).toBeUndefined();
  });
});

describe('claiming by lease', () => {
  test('claims due messages, pushing their next attempt a lease ahead on the database clock', async () => {
    const due = message();
    await enqueue(due);

    const claimed = await claimUntil([due.id]);

    expect(claimed.map((each) => each.id)).toContain(due.id);
    const [lease] = await sql`
      select extract(epoch from next_attempt_at - now()) as seconds from outbox_messages where id = ${due.id}
    `;
    expect(Number(lease.seconds)).toBeGreaterThan(25);
    expect(Number(lease.seconds)).toBeLessThanOrEqual(30);
  });

  test('a message under lease, scheduled later or published is not claimed', async () => {
    const leased = message();
    const later = message({ nextAttemptAt: new Date(Date.now() + 60_000) });
    const published = message();
    published.markPublished(new Date());
    await enqueue(leased, later, published);
    await claimUntil([leased.id]);

    const again = await claimUntil([]);

    const ids = again.map((each) => each.id);
    expect(ids).not.toContain(leased.id);
    expect(ids).not.toContain(later.id);
    expect(ids).not.toContain(published.id);
  });

  test('an expired lease makes the message due again', async () => {
    const due = message();
    await enqueue(due);
    await claimUntil([due.id], 1);

    // Claimed again once the 1 ms lease ran out — waited for, not slept.
    const again = await waitUntil(async () => {
      const ids = (await claimUntil([due.id])).map((each) => each.id);
      return ids.includes(due.id) ? ids : undefined;
    }, 5_000);
    expect(again).toContain(due.id);
  });

  test('concurrent claims skip each other’s locked rows: no message is claimed twice', async () => {
    const messages = Array.from({ length: 30 }, () => message());
    await enqueue(...messages);

    const claims = await Promise.all(
      Array.from({ length: 3 }, () => unitOfWork.run(({ outbox }) => outbox.claimDue(10, 30_000))),
    );

    const ids = claims.flat().map((each) => each.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('after the send', () => {
  test('markPublished records the publication', async () => {
    const sent = message();
    await enqueue(sent);
    sent.markPublished(new Date());

    await unitOfWork.run(({ outbox }) => outbox.markPublished(sent));

    expect((await row(sent.id))?.published_at).toEqual(sent.publishedAt);
  });

  test('reschedule records the attempt and the next one', async () => {
    const failed = message();
    await enqueue(failed);
    failed.scheduleRetry(new Date());

    await unitOfWork.run(({ outbox }) => outbox.reschedule(failed));

    expect(await row(failed.id)).toMatchObject({ attempts: 1, next_attempt_at: failed.nextAttemptAt });
  });
});

describe('outbox_messages constraints', () => {
  test('wallet_id is required, attempts never negative', async () => {
    const insert = (walletId: string | null, attempts: number): Promise<unknown> => sql`
      insert into outbox_messages (id, aggregate_id, event_type, wallet_id, payload, occurred_at, attempts)
      values (${Bun.randomUUIDv7()}, 'x', 'WalletBalanceChanged', ${walletId}, '{}'::jsonb, now(), ${attempts})
    `;

    await expect(insert(null, 0)).rejects.toThrow(/wallet_id/);
    await expect(insert(Bun.randomUUIDv7(), -1)).rejects.toThrow(/outbox_messages_attempts_non_negative/);
  });

  test('the pending messages have a partial index on next_attempt_at', async () => {
    const [index] = await sql`
      select indexdef from pg_indexes where tablename = 'outbox_messages' and indexdef like '%(next_attempt_at)%'
    `;

    expect(index?.indexdef).toContain('WHERE (published_at IS NULL)');
  });
});
