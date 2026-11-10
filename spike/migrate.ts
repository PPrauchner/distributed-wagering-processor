/**
 * Migrations programáticas via Bun — substitui o CLI do MikroORM, que exige Node.
 * Uso: `bun spike/migrate.ts up | down`.
 *
 * @packageDocumentation
 */
import { MikroORM } from '@mikro-orm/postgresql';
import { spikeOrmConfig } from './orm.config.ts';

const direction = process.argv[2];
if (direction !== 'up' && direction !== 'down') {
  console.error('usage: bun spike/migrate.ts up|down');
  process.exit(1);
}

const orm = await MikroORM.init(spikeOrmConfig);
try {
  const applied =
    direction === 'up' ? await orm.migrator.up() : await orm.migrator.down({ to: 0 });
  console.log(JSON.stringify({ direction, migrations: applied.map((m) => m.name) }));
} finally {
  await orm.close(true);
}
