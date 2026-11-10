/**
 * Integration test preload: recreates the test database from scratch on every
 * run and migrates it up, so tests never depend on leftovers of a previous run.
 * Tests then isolate themselves by using their own ids — no cleanup between them.
 *
 * @packageDocumentation
 */
import { SQL } from 'bun';
import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../../src/config.ts';
import { createOrmConfig } from '../../src/database/orm.config.ts';

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

const orm = await MikroORM.init(createOrmConfig(process.env.DATABASE_URL));
try {
  await orm.migrator.up();
} finally {
  await orm.close(true);
}
