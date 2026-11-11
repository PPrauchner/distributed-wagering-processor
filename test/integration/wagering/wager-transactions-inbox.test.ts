/**
 * The wager transaction use case with an inbox entry — a submission that came
 * by the queue — against the real PostgreSQL: the inbox row is recorded in the
 * SQL transaction of the outcome; the same message again is a redelivery,
 * recognized by the inbox's primary key, with no effect; a submission first
 * recorded by HTTP and then received by the queue is a replay; a `FAILED`
 * outcome — a permanent error or retries given up on — records its inbox row
 * in the second unit of work, so a redelivery of its message, once it went to
 * the DLQ, has no effect. Ends checking the ledger invariant of every wallet
 * it touched.
 *
 * @packageDocumentation
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { SQL } from 'bun';
import { createApp } from '../../../src/app.ts';
import { loadConfig } from '../../../src/config.ts';
import { InboxRedeliveryError, type InboxEntry } from '../../../src/messaging/application/inbox-repository.ts';
import { FaultPoint } from '../../../src/shared/application/fault-injector.ts';
import { FailureCode } from '../../../src/shared/domain/failure-code.ts';
import {
  ProcessWagerTransaction,
  type SubmitWagerTransactionCommand,
} from '../../../src/wagering/application/process-wager-transaction.ts';
import { SubmissionChannel } from '../../../src/wagering/domain/rejected-submission.ts';
import { WagerTransactionStatus } from '../../../src/wagering/domain/wager-transaction.ts';
import { expectLedgerConsistent } from '../ledger-invariant.ts';

const CONSUMER = 'wager-transactions-consumer';

let app: INestApplication;
let baseUrl: string;
let useCase: ProcessWagerTransaction;
let sql: SQL;
const touchedWallets: string[] = [];

beforeAll(async () => {
  const config = loadConfig();
  app = await createApp(config);
  await app.listen(0, '127.0.0.1');
  baseUrl = await app.getUrl();
  useCase = app.get(ProcessWagerTransaction);
  sql = new SQL(config.databaseUrl);
});

afterAll(async () => {
  await expectLedgerConsistent(sql, touchedWallets);
  await app?.close();
  await sql?.close();
});

async function createWallet(amount: string): Promise<{ id: string; playerId: string }> {
  const playerId = Bun.randomUUIDv7();
  const response = await fetch(`${baseUrl}/wallets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, initialBalance: { amount, currency: 'BRL' } }),
  });
  expect(response.status).toBe(201);
  const { id } = (await response.json()) as { id: string };
  touchedWallets.push(id);
  return { id, playerId };
}

function betOn(wallet: { id: string; playerId: string }, amount = '25.00'): SubmitWagerTransactionCommand {
  const externalTransactionId = Bun.randomUUIDv7();
  return {
    idempotencyKey: `provider-a:${externalTransactionId}`,
    providerId: 'provider-a',
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount, currency: 'BRL' },
  };
}

function inboxEntry(messageId: string = Bun.randomUUIDv7()): InboxEntry {
  return { consumerName: CONSUMER, messageId, payloadHash: 'f'.repeat(64) };
}

interface WalletState {
  balance_amount: string;
  version: number;
  entries: number;
  outbox: number;
}

async function walletState(walletId: string): Promise<WalletState> {
  const [row] = await sql`
    select w.balance_amount::text, w.version,
           (select count(*)::int from wallet_ledger_entries where wallet_id = w.id) as entries,
           (select count(*)::int from outbox_messages where wallet_id = w.id) as outbox
      from wallets w where w.id = ${walletId}
  `;
  return row;
}

async function inboxRow(messageId: string): Promise<{ payload_hash: string; processed: boolean } | undefined> {
  const [row] = await sql`
    select payload_hash, processed_at is not null as processed
      from inbox_messages where consumer_name = ${CONSUMER} and message_id = ${messageId}
  `;
  return row;
}

describe('a submission received by the queue', () => {
  test('records the inbox row, processed, with the outcome', async () => {
    const wallet = await createWallet('100.00');
    const entry = inboxEntry();

    const outcome = await useCase.execute(betOn(wallet), SubmissionChannel.Queue, entry);

    expect(outcome.transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(outcome.idempotentReplay).toBe(false);
    expect(await inboxRow(entry.messageId)).toEqual({ payload_hash: entry.payloadHash, processed: true });
  });

  test('the same message again is a redelivery, with no effect', async () => {
    const wallet = await createWallet('100.00');
    const entry = inboxEntry();
    const command = betOn(wallet);
    await useCase.execute(command, SubmissionChannel.Queue, entry);
    const before = await walletState(wallet.id);

    const redelivered = useCase.execute(command, SubmissionChannel.Queue, entry);

    await expect(redelivered).rejects.toBeInstanceOf(InboxRedeliveryError);
    expect(await walletState(wallet.id)).toEqual(before);
  });

  test('recorded first by HTTP, it is a replay, and the inbox row is recorded', async () => {
    const wallet = await createWallet('100.00');
    const command = betOn(wallet);
    const first = await useCase.execute(command, SubmissionChannel.Http);
    const before = await walletState(wallet.id);
    const entry = inboxEntry();

    const replay = await useCase.execute(command, SubmissionChannel.Queue, entry);

    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transaction.id).toBe(first.transaction.id);
    expect(await walletState(wallet.id)).toEqual(before);
    expect(await inboxRow(entry.messageId)).toBeDefined();
  });
});

describe('a submission that ended FAILED', () => {
  let faultyApp: INestApplication;
  let faulty: ProcessWagerTransaction;

  beforeAll(async () => {
    faultyApp = await createApp({ ...loadConfig(), faultPoints: [FaultPoint.InvariantViolationBeforeCommit] });
    await faultyApp.init();
    faulty = faultyApp.get(ProcessWagerTransaction);
  });

  afterAll(async () => {
    await faultyApp?.close();
  });

  test('records its inbox row with the FAILED, and the same message again is a redelivery', async () => {
    const wallet = await createWallet('100.00');
    const command = betOn(wallet);
    const entry = inboxEntry();

    const outcome = await faulty.execute(command, SubmissionChannel.Queue, entry);

    expect(outcome.transaction.status).toBe(WagerTransactionStatus.Failed);
    expect(await inboxRow(entry.messageId)).toEqual({ payload_hash: entry.payloadHash, processed: true });
    await expect(faulty.execute(command, SubmissionChannel.Queue, entry)).rejects.toBeInstanceOf(InboxRedeliveryError);
  });

  test('recorded first by HTTP, the queue answers the FAILED replay and records its inbox row', async () => {
    const wallet = await createWallet('100.00');
    const command = betOn(wallet);
    const first = await faulty.execute(command, SubmissionChannel.Http);
    expect(first.transaction.status).toBe(WagerTransactionStatus.Failed);
    const entry = inboxEntry();

    const replay = await useCase.execute(command, SubmissionChannel.Queue, entry);

    expect(replay).toMatchObject({ idempotentReplay: true, transaction: { id: first.transaction.id } });
    expect(await inboxRow(entry.messageId)).toBeDefined();
  });
});

describe('a submission whose retries were given up on', () => {
  test('is recorded FAILED INFRA_RETRIES_EXHAUSTED, with its inbox row and no effect on the wallet', async () => {
    const wallet = await createWallet('100.00');
    const before = await walletState(wallet.id);
    const command = betOn(wallet);
    const entry = inboxEntry();

    const outcome = await useCase.giveUp(command, entry);

    expect(outcome.transaction.status).toBe(WagerTransactionStatus.Failed);
    expect(outcome.transaction.failureCode).toBe(FailureCode.InfraRetriesExhausted);
    expect(await inboxRow(entry.messageId)).toEqual({ payload_hash: entry.payloadHash, processed: true });
    expect(await walletState(wallet.id)).toEqual(before);
  });

  test('already settled meanwhile, it answers that outcome as a replay', async () => {
    const wallet = await createWallet('100.00');
    const command = betOn(wallet);
    const settled = await useCase.execute(command, SubmissionChannel.Http);

    const outcome = await useCase.giveUp(command, inboxEntry());

    expect(outcome).toMatchObject({
      idempotentReplay: true,
      transaction: { id: settled.transaction.id, status: WagerTransactionStatus.Processed },
    });
  });
});
