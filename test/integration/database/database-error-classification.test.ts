/**
 * The single database error classifier against the real PostgreSQL: each row
 * is provoked through MikroORM's flush — the same path a unit of work takes —
 * and the error that comes out is classified.
 *
 * @packageDocumentation
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { MikroORM, type EntityManager } from '@mikro-orm/postgresql';
import { loadConfig } from '../../../src/config.ts';
import { classifyDatabaseError, type DatabaseErrorClass } from '../../../src/database/classify-database-error.ts';
import { createOrmConfig } from '../../../src/database/orm.config.ts';
import { InboxMessage } from '../../../src/messaging/domain/inbox-message.ts';
import { FailureCode } from '../../../src/shared/domain/failure-code.ts';
import { Money } from '../../../src/shared/domain/money.ts';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../src/wagering/domain/wager-transaction.ts';
import { Wallet } from '../../../src/wallet/domain/wallet.ts';
import { LedgerDirection, WalletLedgerEntry } from '../../../src/wallet/domain/wallet-ledger-entry.ts';
import { expectLedgerConsistent } from '../ledger-invariant.ts';

let orm: MikroORM;
let sql: SQL;
const touchedWallets: string[] = [];

beforeAll(async () => {
  const { databaseUrl } = loadConfig();
  orm = await MikroORM.init(createOrmConfig(databaseUrl));
  sql = new SQL(databaseUrl);
});

afterAll(async () => {
  await expectLedgerConsistent(sql, touchedWallets);
  await orm?.close(true);
  await sql?.close();
});

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string): Money => Money.from({ amount, currency: 'USD' });

/** Runs `work` in its own transaction and returns the classified error it ends in. */
async function classifyFailureOf(work: (em: EntityManager) => Promise<void>): Promise<DatabaseErrorClass> {
  try {
    await orm.em.fork().transactional(work);
  } catch (error) {
    return classifyDatabaseError(error);
  }
  throw new Error('the work was expected to fail');
}

async function commit(work: (em: EntityManager) => unknown): Promise<void> {
  await orm.em.fork().transactional(async (em) => {
    await work(em);
  });
}

/** A wallet at zero, committed. */
async function newWallet(playerId: string = Bun.randomUUIDv7()): Promise<Wallet> {
  const wallet = Wallet.open({ id: Bun.randomUUIDv7(), playerId, initialBalance: brl('0.00') });
  await commit((em) => em.persist(wallet));
  touchedWallets.push(wallet.id);
  return wallet;
}

/**
 * A `FAILED` bet on the wallet, moving nothing — rehydrated, not created, so an
 * identifier the domain would refuse still reaches the database.
 */
function failedBet(
  walletId: string,
  ids: { id?: string; key?: string; externalId?: string; roundId?: string } = {},
): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: ids.id ?? Bun.randomUUIDv7(),
    providerId: 'provider-a',
    externalTransactionId: ids.externalId ?? Bun.randomUUIDv7(),
    idempotencyKey: ids.key ?? Bun.randomUUIDv7(),
    payloadHash: 'a'.repeat(64),
    walletId,
    playerId: 'player',
    roundId: ids.roundId ?? 'round',
    gameId: 'game',
    kind: WagerTransactionKind.Bet,
    money: brl('10.00'),
    correlationId: 'corr',
    createdAt: new Date(),
    status: WagerTransactionStatus.Failed,
    failureCode: FailureCode.InfraUnexpected,
    attempts: 0,
  });
}

/** A wallet opened with 100.00: the opening and its entry at version 1, committed. */
async function openedWallet(): Promise<{ wallet: Wallet; openingId: string }> {
  const wallet = Wallet.open({ id: Bun.randomUUIDv7(), playerId: Bun.randomUUIDv7(), initialBalance: brl('100.00') });
  const opening = WagerTransaction.create({
    id: Bun.randomUUIDv7(),
    providerId: 'internal',
    externalTransactionId: `opening:${wallet.id}`,
    idempotencyKey: `opening:${wallet.id}`,
    payloadHash: 'b'.repeat(64),
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: 'opening',
    gameId: 'opening',
    kind: WagerTransactionKind.Opening,
    money: wallet.balance,
    correlationId: 'corr',
  });
  opening.markProcessed({ at: new Date(), balanceAfter: wallet.balance, walletVersionObserved: 1 });
  await commit((em) => {
    em.persist([wallet, opening, wallet.openingEntry({ entryId: Bun.randomUUIDv7(), transactionId: opening.id })]);
  });
  touchedWallets.push(wallet.id);
  return { wallet, openingId: opening.id };
}

function creditEntry(props: {
  walletId: string;
  transactionId: string;
  before: Money;
  money: Money;
  walletVersion: number;
}): WalletLedgerEntry {
  return WalletLedgerEntry.create({
    id: Bun.randomUUIDv7(),
    walletId: props.walletId,
    transactionId: props.transactionId,
    direction: LedgerDirection.Credit,
    money: props.money,
    balanceBefore: props.before,
    balanceAfter: props.before.add(props.money),
    walletVersion: props.walletVersion,
    createdAt: new Date(),
  });
}

/** A `PROCESSED` refund undoing the referenced transaction — moving nothing here, only the row. */
function processedRefund(wallet: Wallet, referenceTransactionId: string): WagerTransaction {
  const refund = WagerTransaction.create({
    id: Bun.randomUUIDv7(),
    providerId: 'provider-a',
    externalTransactionId: Bun.randomUUIDv7(),
    idempotencyKey: Bun.randomUUIDv7(),
    payloadHash: 'c'.repeat(64),
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: 'round',
    gameId: 'game',
    kind: WagerTransactionKind.Refund,
    money: brl('10.00'),
    referenceExternalTransactionId: 'bet-1',
    correlationId: 'corr',
  });
  refund.markProcessed({ at: new Date(), balanceAfter: wallet.balance, walletVersionObserved: 1, referenceTransactionId });
  return refund;
}

const invariantViolation: DatabaseErrorClass = {
  category: 'permanent',
  failureCode: FailureCode.InfraInvariantViolation,
};

describe('23505, by constraint', () => {
  test('the provider idempotency key → reread', async () => {
    const wallet = await newWallet();
    const key = Bun.randomUUIDv7();
    await commit((em) => em.persist(failedBet(wallet.id, { key })));

    const result = await classifyFailureOf(async (em) => {
      em.persist(failedBet(wallet.id, { key }));
    });

    expect(result).toEqual({ category: 'reread', target: 'wager-transaction-idempotency-key' });
  });

  test('the wallet creation key → reread', async () => {
    const creation = { idempotencyKey: Bun.randomUUIDv7(), payloadHash: 'd'.repeat(64) };
    const first = Wallet.open({ id: Bun.randomUUIDv7(), playerId: Bun.randomUUIDv7(), initialBalance: brl('0.00'), creation });
    await commit((em) => em.persist(first));
    touchedWallets.push(first.id);

    const result = await classifyFailureOf(async (em) => {
      em.persist(Wallet.open({ id: Bun.randomUUIDv7(), playerId: Bun.randomUUIDv7(), initialBalance: brl('0.00'), creation }));
    });

    expect(result).toEqual({ category: 'reread', target: 'wallet-creation-idempotency-key' });
  });

  test('the provider external id → EXTERNAL_ID_CONFLICT', async () => {
    const wallet = await newWallet();
    const externalId = Bun.randomUUIDv7();
    await commit((em) => em.persist(failedBet(wallet.id, { externalId })));

    const result = await classifyFailureOf(async (em) => {
      em.persist(failedBet(wallet.id, { externalId }));
    });

    expect(result).toEqual({ category: 'conflict', failureCode: FailureCode.ExternalIdConflict });
  });

  test('one wallet per player and currency → WALLET_ALREADY_EXISTS', async () => {
    const existing = await newWallet();

    const result = await classifyFailureOf(async (em) => {
      em.persist(Wallet.open({ id: Bun.randomUUIDv7(), playerId: existing.playerId, initialBalance: brl('0.00') }));
    });

    expect(result).toEqual({ category: 'conflict', failureCode: FailureCode.WalletAlreadyExists });
  });

  test('a second ledger entry of the same transaction and wallet → INFRA_INVARIANT_VIOLATION', async () => {
    const { wallet, openingId } = await openedWallet();

    const result = await classifyFailureOf(async (em) => {
      em.persist(
        creditEntry({ walletId: wallet.id, transactionId: openingId, before: brl('100.00'), money: brl('1.00'), walletVersion: 2 }),
      );
    });

    expect(result).toEqual(invariantViolation);
  });

  test('a second ledger entry at the same wallet version → INFRA_INVARIANT_VIOLATION', async () => {
    const { wallet } = await openedWallet();

    const result = await classifyFailureOf(async (em) => {
      const transaction = failedBet(wallet.id);
      em.persist(transaction);
      em.persist(
        creditEntry({ walletId: wallet.id, transactionId: transaction.id, before: brl('0.00'), money: brl('1.00'), walletVersion: 1 }),
      );
    });

    expect(result).toEqual(invariantViolation);
  });

  test('a second processed reversal of the same reference → INFRA_INVARIANT_VIOLATION', async () => {
    const { wallet, openingId } = await openedWallet();
    await commit((em) => em.persist(processedRefund(wallet, openingId)));

    let thrown: unknown;
    try {
      await orm.em.fork().transactional(async (em) => {
        em.persist(processedRefund(wallet, openingId));
      });
    } catch (error) {
      thrown = error;
    }

    // The constraint, so the row is reached by the reversal index and not by another.
    expect(Reflect.get(thrown as object, 'constraint')).toBe('wager_transactions_single_reversal_unique');
    expect(classifyDatabaseError(thrown)).toEqual(invariantViolation);
  });

  test('the inbox (consumer_name, message_id) → redelivery', async () => {
    const messageId = Bun.randomUUIDv7();
    const received = () =>
      InboxMessage.receive({
        consumerName: 'wager-transactions-consumer',
        messageId,
        payloadHash: 'a'.repeat(64),
        receivedAt: new Date(),
      });
    await commit((em) => em.persist(received()));

    let thrown: unknown;
    try {
      await orm.em.fork().transactional(async (em) => {
        em.persist(received());
      });
    } catch (error) {
      thrown = error;
    }

    // The constraint by its reserved name: the classifier knows it by that one.
    expect(Reflect.get(thrown as object, 'constraint')).toBe('inbox_messages_pkey');
    expect(classifyDatabaseError(thrown)).toEqual({ category: 'redelivery' });
  });

  test('any other unique constraint: a duplicate primary key → INFRA_UNEXPECTED', async () => {
    const wallet = await newWallet();
    const transaction = failedBet(wallet.id);
    await commit((em) => em.persist(transaction));

    let thrown: unknown;
    try {
      await orm.em.fork().transactional(async (em) => {
        em.persist(failedBet(wallet.id, { id: transaction.id }));
      });
    } catch (error) {
      thrown = error;
    }

    // The constraint, so the row is reached by an unmapped unique and not by another.
    expect(Reflect.get(thrown as object, 'code')).toBe('23505');
    expect(Reflect.get(thrown as object, 'constraint')).toBe('wager_transactions_pkey');
    expect(classifyDatabaseError(thrown)).toEqual({ category: 'permanent', failureCode: FailureCode.InfraUnexpected });
  });
});

describe('schema invariants → INFRA_INVARIANT_VIOLATION', () => {
  test('a CHECK: the balance in another currency than the wallet', async () => {
    const wallet = await newWallet();

    const result = await classifyFailureOf(async (em) => {
      const loaded = await em.findOneOrFail(Wallet, { id: wallet.id });
      Reflect.set(loaded, '_balance', usd('0.00'));
    });

    expect(result).toEqual(invariantViolation);
  });

  test("the currency foreign key: an entry in another currency than its wallet's", async () => {
    const wallet = await newWallet();

    const result = await classifyFailureOf(async (em) => {
      const transaction = failedBet(wallet.id);
      em.persist(transaction);
      em.persist(
        creditEntry({ walletId: wallet.id, transactionId: transaction.id, before: usd('0.00'), money: usd('1.00'), walletVersion: 2 }),
      );
    });

    expect(result).toEqual(invariantViolation);
  });

  test('a trigger: changing a terminal transaction', async () => {
    const wallet = await newWallet();
    const transaction = failedBet(wallet.id);
    await commit((em) => em.persist(transaction));

    const result = await classifyFailureOf(async (em) => {
      const loaded = await em.findOneOrFail(WagerTransaction, { id: transaction.id });
      Reflect.set(loaded, '_failureCode', FailureCode.InfraInvariantViolation);
    });

    expect(result).toEqual(invariantViolation);
  });

  test('22003: a balance beyond numeric(19,2)', async () => {
    const wallet = await newWallet();

    const result = await classifyFailureOf(async (em) => {
      const loaded = await em.findOneOrFail(Wallet, { id: wallet.id });
      const huge = brl('0.00');
      Reflect.set(huge, '_amount', '100000000000000000.00');
      Reflect.set(loaded, '_balance', huge);
    });

    expect(result).toEqual(invariantViolation);
  });
});

describe('transient', () => {
  test('55P03: the wallet held by another connection beyond lock_timeout → TRANSIENT_LOCK_TIMEOUT', async () => {
    const wallet = await newWallet();
    const holder = await sql.reserve();
    try {
      await holder`begin`;
      await holder`select id from wallets where id = ${wallet.id} for update`;

      const result = await classifyFailureOf(async (em) => {
        await em.execute(`set local lock_timeout = '100ms'`);
        const loaded = await em.findOneOrFail(Wallet, { id: wallet.id });
        Reflect.set(loaded, '_updatedAt', new Date());
      });

      expect(result).toEqual({
        category: 'transient',
        failureCode: FailureCode.TransientLockTimeout,
        lockConflict: 'lock_timeout',
      });
    } finally {
      await holder`rollback`;
      holder.release();
    }
  });

  test('a refused connection → TRANSIENT_UNAVAILABLE', async () => {
    const unreachable = new URL(loadConfig().databaseUrl);
    unreachable.port = '1';
    const offline = await MikroORM.init(createOrmConfig(unreachable.toString()));
    try {
      let result: DatabaseErrorClass | undefined;
      try {
        await offline.em.fork().transactional(async (em) => {
          em.persist(Wallet.open({ id: Bun.randomUUIDv7(), playerId: 'p', initialBalance: brl('0.00') }));
        });
      } catch (error) {
        result = classifyDatabaseError(error);
      }

      expect(result).toEqual({ category: 'transient', failureCode: FailureCode.TransientUnavailable });
    } finally {
      await offline.close(true);
    }
  });
});

describe('anything else → INFRA_UNEXPECTED', () => {
  test('22001: an identifier beyond its varchar(255) column', async () => {
    const wallet = await newWallet();

    let thrown: unknown;
    try {
      await orm.em.fork().transactional(async (em) => {
        em.persist(failedBet(wallet.id, { roundId: 'r'.repeat(256) }));
      });
    } catch (error) {
      thrown = error;
    }

    // The SQLSTATE, so the row is reached by the database and not by a domain error.
    expect(Reflect.get(thrown as object, 'code')).toBe('22001');
    expect(classifyDatabaseError(thrown)).toEqual({ category: 'permanent', failureCode: FailureCode.InfraUnexpected });
  });
});
