/**
 * Runs the migrations from a Bun script — replaces the MikroORM CLI, which
 * requires Node (ADR 0001). Usage: `bun src/database/migrate.ts up|down`.
 * Prints the applied migrations as JSON on the last line.
 *
 * @packageDocumentation
 */
import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../config.ts';
import { createOrmConfig } from './orm.config.ts';

const direction = process.argv[2];
if (direction !== 'up' && direction !== 'down') {
  console.error('usage: bun src/database/migrate.ts up|down');
  process.exit(1);
}

const orm = await MikroORM.init(createOrmConfig(loadConfig().databaseUrl));
try {
  const applied =
    direction === 'up' ? await orm.migrator.up() : await orm.migrator.down({ to: 0 });
  console.log(JSON.stringify({ direction, migrations: applied.map((m) => m.name) }));
} finally {
  await orm.close(true);
}
