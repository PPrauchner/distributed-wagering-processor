/**
 * Configuração do MikroORM do spike. Entidades e migrations são registradas
 * explicitamente: sem glob nem descoberta por sistema de arquivos, que falham ou
 * exigem Node no Bun.
 *
 * @packageDocumentation
 */
import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { SpikeWalletSchema } from './spike-wallet.schema.ts';
import { Migration0001SpikeWallets } from './migrations/0001-spike-wallets.ts';

// 127.0.0.1 e não localhost: no Windows, localhost tenta IPv6 primeiro e cada
// conexão nova leva ~300 ms — o bastante para serializar transações por acaso e
// mascarar uma corrida nos testes.
export const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://wagering:wagering@127.0.0.1:55432/wagering';

export const spikeOrmConfig = defineConfig({
  clientUrl: DATABASE_URL,
  entities: [SpikeWalletSchema],
  extensions: [Migrator],
  migrations: {
    migrationsList: [{ name: 'Migration0001SpikeWallets', class: Migration0001SpikeWallets }],
    tableName: 'spike_migrations',
    // Migrations escritas à mão; o snapshot só serve à geração automática de diffs.
    snapshot: false,
  },
  pool: { min: 0, max: 10 },
  debug: false,
});
