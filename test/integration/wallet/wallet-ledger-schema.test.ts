/**
 * The ledger guaranteed by the schema, proven by raw SQL: entries are immutable,
 * every balance change is tied to an entry by the wallet version (ADR 0003), the
 * entry's arithmetic and currency hold, every entry is tied to an applied
 * transaction of the same terms and direction, no entry stands without its
 * balance change, and a wallet's identity never changes. The code path is not
 * trusted to hold any of it.
 *
 * @packageDocumentation
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { loadConfig } from '../../../src/config.ts';
import { expectLedgerConsistent } from '../ledger-invariant.ts';

let sql: SQL;
const touchedWallets: string[] = [];

beforeAll(() => {
  sql = new SQL(loadConfig().databaseUrl);
});

afterAll(async () => {
  await expectLedgerConsistent(sql, touchedWallets);
  await sql?.close();
});

interface EntryRow {
  walletId: string;
  transactionId: string;
  direction?: string;
  amount: string;
  currency?: string;
  before: string;
  after: string;
  version: number;
}

async function insertWallet(tx: SQL, balance: string, currency = 'BRL'): Promise<string> {
  const id = Bun.randomUUIDv7();
  await tx`
    insert into wallets (id, player_id, currency, balance_amount, balance_currency, version, created_at, updated_at, initial_balance_amount, initial_balance_currency)
    values (${id}, ${Bun.randomUUIDv7()}, ${currency}, ${balance}, ${currency}, 1, now(), now(), ${balance}, ${currency})
  `;
  return id;
}

type Row = Record<string, string | number | Date | null>;

/** A `PROCESSED` transaction in BRL; overrides make it anything else. */
async function insertTransaction(
  tx: SQL,
  walletId: string,
  amount: string,
  kind = 'OPENING',
  overrides: Row = {},
): Promise<string> {
  const id = Bun.randomUUIDv7();
  const row: Row = {
    id,
    provider_id: 'internal',
    external_transaction_id: id,
    idempotency_key: id,
    payload_hash: '0'.repeat(64),
    wallet_id: walletId,
    player_id: 'player',
    round_id: 'round',
    game_id: 'game',
    kind,
    amount,
    currency: 'BRL',
    status: 'PROCESSED',
    processed_at: new Date(),
    balance_after_amount: amount,
    balance_after_currency: 'BRL',
    wallet_version_observed: 1,
    correlation_id: 'corr',
    created_at: new Date(),
    ...overrides,
  };
  await tx`insert into wager_transactions ${tx(row)}`;
  return id;
}

async function insertEntry(tx: SQL, entry: EntryRow): Promise<string> {
  const id = Bun.randomUUIDv7();
  const currency = entry.currency ?? 'BRL';
  await tx`
    insert into wallet_ledger_entries (
      id, wallet_id, transaction_id, direction, amount, currency, balance_before_amount,
      balance_before_currency, balance_after_amount, balance_after_currency, wallet_version, created_at
    ) values (
      ${id}, ${entry.walletId}, ${entry.transactionId}, ${entry.direction ?? 'CREDIT'}, ${entry.amount},
      ${currency}, ${entry.before}, ${currency}, ${entry.after}, ${currency}, ${entry.version}, now()
    )
  `;
  return id;
}

/** A wallet opened at 100.00 BRL with its opening, as the use case writes it. */
async function openedWallet(): Promise<{ walletId: string; entryId: string }> {
  return sql.begin(async (tx) => {
    const walletId = await insertWallet(tx, '100.00');
    const transactionId = await insertTransaction(tx, walletId, '100.00');
    const entryId = await insertEntry(tx, {
      walletId,
      transactionId,
      amount: '100.00',
      before: '0.00',
      after: '100.00',
      version: 1,
    });
    touchedWallets.push(walletId);
    return { walletId, entryId };
  });
}

/** Moves the wallet balance and version, with or without the matching entry. */
function credit(
  walletId: string,
  change: { to: string; version: number; entry?: Partial<EntryRow> | false },
): Promise<void> {
  return sql.begin(async (tx) => {
    const [wallet] = await tx`select balance_amount::text as balance from wallets where id = ${walletId} for update`;
    await tx`update wallets set balance_amount = ${change.to}, version = ${change.version} where id = ${walletId}`;
    if (change.entry === false) return;
    const transactionId = await insertTransaction(tx, walletId, '30.00', 'WIN');
    await insertEntry(tx, {
      walletId,
      transactionId,
      amount: '30.00',
      before: wallet.balance,
      after: change.to,
      version: change.version,
      ...change.entry,
    });
  });
}

describe('balance ↔ ledger, checked at commit', () => {
  test('a wallet opened with a balance and its opening entry commits', async () => {
    const { walletId } = await openedWallet();

    const [row] = await sql`select balance_amount::text as balance, version from wallets where id = ${walletId}`;
    expect(row).toEqual({ balance: '100.00', version: 1 });
  });

  test('inserting a wallet with a positive balance and no entry fails on commit', async () => {
    const attempt = sql.begin((tx) => insertWallet(tx, '100.00'));

    await expect(attempt).rejects.toThrow(/wallets_balance_ledger_mismatch/);
  });

  test('a credit with its entry at the next version commits', async () => {
    const { walletId } = await openedWallet();

    await credit(walletId, { to: '130.00', version: 2 });

    const [row] = await sql`select balance_amount::text as balance, version from wallets where id = ${walletId}`;
    expect(row).toEqual({ balance: '130.00', version: 2 });
  });

  test('changing the balance without an entry fails on commit', async () => {
    const { walletId } = await openedWallet();

    await expect(credit(walletId, { to: '130.00', version: 2, entry: false })).rejects.toThrow(
      /wallets_balance_ledger_mismatch/,
    );
  });

  test('an entry that does not lead from the old balance to the new one fails on commit', async () => {
    const { walletId } = await openedWallet();

    const attempt = credit(walletId, {
      to: '130.00',
      version: 2,
      entry: { before: '70.00', after: '100.00' },
    });

    await expect(attempt).rejects.toThrow(/wallets_balance_ledger_mismatch/);
  });

  // The entry is written at the version the wallet should have reached, 2, so
  // only the wallet's own version is wrong.
  test.each([
    ['skips a version', 3],
    ['keeps the version', 1],
  ])('a balance change that %s fails on commit', async (_case, version) => {
    const { walletId } = await openedWallet();

    await expect(credit(walletId, { to: '130.00', version, entry: { version: 2 } })).rejects.toThrow(
      /wallets_balance_ledger_mismatch/,
    );
  });

  test('a version change without a balance change fails on commit', async () => {
    const { walletId } = await openedWallet();

    const attempt = sql.begin((tx) => tx`update wallets set version = 2 where id = ${walletId}`);

    await expect(attempt).rejects.toThrow(/wallets_balance_ledger_mismatch/);
  });

  test('a zero-balance wallet is born at version 1', async () => {
    const attempt = sql.begin(
      (tx) => tx`
        insert into wallets (id, player_id, currency, balance_amount, balance_currency, version, created_at, updated_at, initial_balance_amount, initial_balance_currency)
        values (${Bun.randomUUIDv7()}, 'player', 'BRL', 0, 'BRL', 2, now(), now(), 0, 'BRL')
      `,
    );

    await expect(attempt).rejects.toThrow(/wallets_balance_ledger_mismatch/);
  });
});

describe('the ledger is immutable', () => {
  test.each([
    ['UPDATE', (id: string) => sql`update wallet_ledger_entries set created_at = now() where id = ${id}`],
    ['DELETE', (id: string) => sql`delete from wallet_ledger_entries where id = ${id}`],
  ])('%s of an entry fails', async (_case, statement) => {
    const { entryId } = await openedWallet();

    await expect(statement(entryId)).rejects.toThrow(/wallet_ledger_entries_immutable/);
  });

  test('TRUNCATE fails', async () => {
    await openedWallet();

    await expect(sql`truncate wallet_ledger_entries cascade`).rejects.toThrow(/wallet_ledger_entries_immutable/);
  });
});

describe('entry arithmetic and currency', () => {
  // Each attempt opens a fresh wallet whose opening entry is the one under test.
  function openWith(entry: Partial<EntryRow>, walletCurrency = 'BRL'): Promise<void> {
    return sql.begin(async (tx) => {
      const walletId = await insertWallet(tx, '100.00', walletCurrency);
      // The transaction follows the entry's currency: only the wallet's may differ.
      const currency = entry.currency ?? 'BRL';
      const transactionId = await insertTransaction(tx, walletId, '100.00', 'OPENING', {
        currency,
        balance_after_currency: currency,
      });
      await insertEntry(tx, {
        walletId,
        transactionId,
        amount: '100.00',
        before: '0.00',
        after: '100.00',
        version: 1,
        ...entry,
      });
    });
  }

  test.each([
    ['a credit that does not add up', { after: '99.99' }, /wallet_ledger_entries_arithmetic/],
    ['a debit written as a credit', { direction: 'DEBIT' }, /wallet_ledger_entries_arithmetic/],
    ['a zero amount', { amount: '0.00', after: '0.00' }, /wallet_ledger_entries_amount_positive/],
    ['a negative amount', { amount: '-100.00', direction: 'DEBIT' }, /wallet_ledger_entries_amount_positive/],
    ['a negative balance', { before: '-100.00', after: '0.00' }, /wallet_ledger_entries_arithmetic/],
    ['an entry in another currency than the wallet', { currency: 'USD' }, /wallet_ledger_entries_wallet_currency_fk/],
    ['an unknown direction', { direction: 'SIDEWAYS' }, /wallet_ledger_entries_(direction|arithmetic)/],
  ])('%s fails', async (_case, entry, error) => {
    await expect(openWith(entry)).rejects.toThrow(error);
  });

  test('balances in another currency than the amount fail', async () => {
    const attempt = sql.begin(async (tx) => {
      const walletId = await insertWallet(tx, '100.00');
      const transactionId = await insertTransaction(tx, walletId, '100.00');
      await tx`
        insert into wallet_ledger_entries (
          id, wallet_id, transaction_id, direction, amount, currency, balance_before_amount,
          balance_before_currency, balance_after_amount, balance_after_currency, wallet_version, created_at
        ) values (
          ${Bun.randomUUIDv7()}, ${walletId}, ${transactionId}, 'CREDIT', 100, 'BRL', 0, 'USD', 100, 'BRL', 1, now()
        )
      `;
    });

    await expect(attempt).rejects.toThrow(/wallet_ledger_entries_currency_matches/);
  });

  test('a transaction writes at most one entry per wallet', async () => {
    const { walletId } = await openedWallet();
    const [opening] = await sql`select transaction_id from wallet_ledger_entries where wallet_id = ${walletId}`;

    // The opening's own terms, so only the second entry for it is wrong.
    const attempt = credit(walletId, {
      to: '200.00',
      version: 2,
      entry: { transactionId: opening.transaction_id, amount: '100.00' },
    });

    await expect(attempt).rejects.toThrow(/wallet_ledger_entries_transaction_wallet_unique/);
  });
});

const DIRECTION_OF: Record<string, string> = {
  OPENING: 'CREDIT',
  BET: 'DEBIT',
  WIN: 'CREDIT',
  LOSS: 'CREDIT',
  REFUND: 'CREDIT',
};

interface Move {
  kind: string;
  /** Defaults to the kind's; required for a `ROLLBACK`. */
  direction?: string;
  amount?: string;
  /** Overrides of the transaction row, coherent with its own CHECKs. */
  transaction?: Row;
}

/**
 * Applies a transaction to the wallet the way the use case does: the wallet
 * moves by the entry's amount in its direction to the next version, and the
 * transaction and its entry are written in the same SQL transaction.
 *
 * @returns The id of the transaction applied.
 */
function move(walletId: string, change: Move): Promise<string> {
  const amount = change.amount ?? '30.00';
  const direction = change.direction ?? DIRECTION_OF[change.kind]!;
  const sign = direction === 'DEBIT' ? -1 : 1;
  return sql.begin(async (tx) => {
    const [before] = await tx`
      select balance_amount::text as balance, version from wallets where id = ${walletId} for update
    `;
    const [after] = await tx`
      update wallets set balance_amount = balance_amount + ${amount}::numeric * ${sign}, version = version + 1
       where id = ${walletId}
      returning balance_amount::text as balance, version
    `;
    const transactionId = await insertTransaction(tx, walletId, amount, change.kind, {
      balance_after_amount: after.balance,
      wallet_version_observed: after.version,
      ...change.transaction,
    });
    await insertEntry(tx, {
      walletId,
      transactionId,
      direction,
      amount,
      before: before.balance,
      after: after.balance,
      version: after.version,
    });
    return transactionId;
  });
}

/** The reference columns of a `REFUND` or `ROLLBACK` of the given transaction. */
function referencing(referenceId: string): Row {
  return { reference_external_transaction_id: referenceId, reference_transaction_id: referenceId };
}

describe('the entry is tied to its transaction', () => {
  const COHERENCE = 'wallet_ledger_entries_transaction_coherence';

  test('every kind that moves the balance commits in its direction, reversals included', async () => {
    const { walletId } = await openedWallet();

    const bet = await move(walletId, { kind: 'BET' });
    await move(walletId, { kind: 'REFUND', transaction: referencing(bet) });
    const win = await move(walletId, { kind: 'WIN' });
    await move(walletId, { kind: 'ROLLBACK', direction: 'DEBIT', transaction: referencing(win) });
    const secondBet = await move(walletId, { kind: 'BET' });
    await move(walletId, { kind: 'ROLLBACK', direction: 'CREDIT', transaction: referencing(secondBet) });

    const [row] = await sql`select balance_amount::text as balance, version from wallets where id = ${walletId}`;
    expect(row).toEqual({ balance: '100.00', version: 7 });
  });

  test.each([
    ['REJECTED', { status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS', processed_at: null }],
    [
      'FAILED',
      {
        status: 'FAILED',
        failure_code: 'INFRA_UNEXPECTED',
        processed_at: null,
        balance_after_amount: null,
        balance_after_currency: null,
        wallet_version_observed: null,
      },
    ],
    [
      'PENDING_REFERENCE',
      {
        status: 'PENDING_REFERENCE',
        processed_at: null,
        balance_after_amount: null,
        balance_after_currency: null,
        wallet_version_observed: null,
        next_attempt_at: new Date(),
      },
    ],
  ])('an entry of a %s transaction fails on commit', async (status, transaction) => {
    const { walletId } = await openedWallet();

    const attempt = move(walletId, { kind: 'WIN', transaction: transaction as Row });

    await expect(attempt).rejects.toThrow(new RegExp(`${COHERENCE}: .* is ${status}`));
  });

  test('an entry of a LOSS fails on commit', async () => {
    const { walletId } = await openedWallet();

    await expect(move(walletId, { kind: 'LOSS' })).rejects.toThrow(new RegExp(`${COHERENCE}: .* LOSS`));
  });

  test.each([
    ['an amount', { amount: '40.00' }],
    ['a currency', { currency: 'USD', balance_after_currency: 'USD' }],
  ])('%s other than the transaction’s fails', async (_case, transaction) => {
    const { walletId } = await openedWallet();

    const attempt = move(walletId, { kind: 'WIN', transaction });

    await expect(attempt).rejects.toThrow(/wallet_ledger_entries_transaction_terms_fk/);
  });

  test('a wallet other than the transaction’s fails', async () => {
    const { walletId } = await openedWallet();
    const { walletId: otherWalletId } = await openedWallet();

    const attempt = move(walletId, { kind: 'WIN', transaction: { wallet_id: otherWalletId } });

    await expect(attempt).rejects.toThrow(/wallet_ledger_entries_transaction_terms_fk/);
  });

  test.each([
    ['BET', 'CREDIT'],
    ['WIN', 'DEBIT'],
    ['OPENING', 'DEBIT'],
  ])('a %s written as a %s fails on commit', async (kind, direction) => {
    const { walletId } = await openedWallet();

    const attempt = move(walletId, { kind, direction });

    await expect(attempt).rejects.toThrow(new RegExp(`${COHERENCE}: .* ${kind} .* ${direction}`));
  });

  test('a REFUND written as a DEBIT fails on commit', async () => {
    const { walletId } = await openedWallet();
    const bet = await move(walletId, { kind: 'BET' });

    const attempt = move(walletId, { kind: 'REFUND', direction: 'DEBIT', transaction: referencing(bet) });

    await expect(attempt).rejects.toThrow(new RegExp(`${COHERENCE}: .* REFUND .* DEBIT`));
  });

  test('a ROLLBACK in the direction of the entry it undoes fails on commit', async () => {
    const { walletId } = await openedWallet();
    const bet = await move(walletId, { kind: 'BET' });

    const attempt = move(walletId, { kind: 'ROLLBACK', direction: 'DEBIT', transaction: referencing(bet) });

    await expect(attempt).rejects.toThrow(new RegExp(`${COHERENCE}: .* ROLLBACK .* DEBIT`));
  });

  test('a ROLLBACK of a transaction without an entry fails on commit', async () => {
    const { walletId } = await openedWallet();
    const loss = await sql.begin((tx) =>
      insertTransaction(tx, walletId, '30.00', 'LOSS', { balance_after_amount: '100.00' }),
    );

    const attempt = move(walletId, { kind: 'ROLLBACK', direction: 'CREDIT', transaction: referencing(loss) });

    await expect(attempt).rejects.toThrow(new RegExp(`${COHERENCE}: .* no entry`));
  });
});

describe('no entry without its balance change', () => {
  test('an entry written without moving the wallet fails on commit', async () => {
    const { walletId } = await openedWallet();

    const attempt = sql.begin(async (tx) => {
      const transactionId = await insertTransaction(tx, walletId, '30.00', 'WIN');
      await insertEntry(tx, { walletId, transactionId, amount: '30.00', before: '100.00', after: '130.00', version: 2 });
    });

    await expect(attempt).rejects.toThrow(/wallet_ledger_entries_balance_applied/);
  });
});

describe('wallet identity is immutable', () => {
  test.each([
    ['id', (id: string) => sql`update wallets set id = ${Bun.randomUUIDv7()} where id = ${id}`],
    ['player_id', (id: string) => sql`update wallets set player_id = 'someone-else' where id = ${id}`],
    [
      'currency',
      (id: string) => sql`update wallets set currency = 'USD', balance_currency = 'USD' where id = ${id}`,
    ],
  ])('changing %s fails', async (_case, statement) => {
    const { walletId } = await openedWallet();

    await expect(statement(walletId)).rejects.toThrow(/wallets_identity_immutable/);
  });
});

describe('wager_transactions', () => {
  test('a transaction needs an existing wallet', async () => {
    const attempt = sql.begin((tx) => insertTransaction(tx, Bun.randomUUIDv7(), '10.00'));

    await expect(attempt).rejects.toThrow(/foreign key/);
  });

  test('a transaction amount must be positive', async () => {
    const { walletId } = await openedWallet();

    await expect(sql.begin((tx) => insertTransaction(tx, walletId, '0.00'))).rejects.toThrow(
      /wager_transactions_amount_positive/,
    );
  });
});

describe('the maximum balance', () => {
  test('a direct UPDATE past 99999999999999999.99 is refused by the column type', async () => {
    const { walletId } = await openedWallet();

    const attempt = sql`update wallets set balance_amount = 100000000000000000.00, version = 2 where id = ${walletId}`;

    await expect(attempt).rejects.toThrow(/numeric field overflow/);
    const [row] = await sql`select balance_amount::text as balance, version from wallets where id = ${walletId}`;
    expect(row).toEqual({ balance: '100.00', version: 1 });
  });
});
