/**
 * Integration test preload: recreates the test database from scratch on every
 * run and migrates it up, so tests never depend on leftovers of a previous run.
 * Tests then isolate themselves by using their own ids — no cleanup between them.
 *
 * Shared by the integration and the concurrency suites. After the whole run —
 * once every file has ended, and with it the app processes it started — a
 * global `afterAll` reconciles every wallet of the test database: one left
 * inconsistent by any test fails the run, unless that test excluded it with
 * `excludeFromLedgerInvariant`. The per-file checks still run.
 *
 * @packageDocumentation
 */
import { afterAll } from 'bun:test';
import { SQL } from 'bun';
import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../../src/config.ts';
import { createOrmConfig } from '../../src/database/orm.config.ts';
import { findInconsistentWallets } from './ledger-invariant.ts';

const baseUrl = new URL(loadConfig().databaseUrl);
const testDatabase = `${baseUrl.pathname.slice(1)}_test`;

const admin = new SQL(baseUrl.toString());
try {
  await admin.unsafe(`drop database if exists "${testDatabase}" with (force)`);
  await admin.unsafe(`create database "${testDatabase}"`);
} finally {
  await admin.close();
}

baseUrl.pathname = `/${testDatabase}`;
process.env.DATABASE_URL = baseUrl.toString();
// The apps the tests start run no outbox publisher unless a test turns one on,
// with a queue of its own: nothing reaches the development queues.
process.env.OUTBOX_PUBLISHER_ENABLED = 'false';
// Nor a consumer of the input queue, for the same reason.
process.env.WAGER_TRANSACTIONS_CONSUMER_ENABLED = 'false';
// Nor the worker of pending references: a test resolving them runs its own.
process.env.PENDING_REFERENCES_WORKER_ENABLED = 'false';

const orm = await MikroORM.init(createOrmConfig(process.env.DATABASE_URL));
try {
  await orm.migrator.up();
} finally {
  await orm.close(true);
}

afterAll(async () => {
  const sql = new SQL(process.env.DATABASE_URL!);
  try {
    const inconsistent = await findInconsistentWallets(sql);
    if (inconsistent.length > 0) {
      throw new Error(`ledger invariant broken after the run:\n${JSON.stringify(inconsistent, null, 2)}`);
    }
  } finally {
    await sql.close();
  }
});
