/**
 * Spike do ADR 0001: prova Bun + NestJS 12 + MikroORM 7 + PostgreSQL contra um
 * banco real (`docker compose up -d postgres`).
 *
 * @packageDocumentation
 */
import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import { InsufficientFundsError, SpikeWallet } from './spike-wallet.ts';
import {
  SpikeModule,
  SpikeWalletService,
  type TimelineEvent,
  type TimelinePhase,
} from './spike-wallet.service.ts';

let app: INestApplication;
let orm: MikroORM;
let service: SpikeWalletService;

async function tableExists(): Promise<boolean> {
  const rows = await orm.em
    .getConnection()
    .execute<{ exists: boolean }[]>("select to_regclass('spike_wallets') is not null as exists");
  return rows[0]!.exists;
}

async function openWallet(balance: string): Promise<string> {
  const wallet = SpikeWallet.open(randomUUID(), balance);
  await orm.em.fork().persist(wallet).flush();
  return wallet.id;
}

function at(timeline: TimelineEvent[], label: string, phase: TimelinePhase): number {
  const event = timeline.find((e) => e.label === label && e.phase === phase);
  if (!event) throw new Error(`missing ${label}:${phase}`);
  return event.at;
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [SpikeModule] }).compile();
  app = moduleRef.createNestApplication();
  await app.listen(0);
  orm = app.get(MikroORM);
  service = app.get(SpikeWalletService);
  await orm.migrator.down({ to: 0 });
  await orm.migrator.up();
});

afterAll(async () => {
  await app?.close();
});

beforeEach(() => {
  service.timeline.length = 0;
});

describe('migrations programáticas (sem o CLI do MikroORM)', () => {
  test('down remove a tabela e up a recria', async () => {
    await orm.migrator.down({ to: 0 });
    expect(await tableExists()).toBe(false);

    const applied = await orm.migrator.up();
    expect(applied.map((m) => m.name)).toEqual(['Migration0001SpikeWallets']);
    expect(await tableExists()).toBe(true);
  });
});

describe('mapeamento por defineEntity de classe com construtor privado', () => {
  test('hidrata a classe de domínio com o decimal como string exata', async () => {
    const id = await openWallet('100.00');
    const loaded = await orm.em.fork().findOneOrFail(SpikeWallet, id);

    expect(loaded).toBeInstanceOf(SpikeWallet);
    expect(loaded.balance).toBe('100.00');
    expect(typeof loaded.balance).toBe('string');
    expect(loaded.version).toBe(1);
  });

  test('o CHECK do schema barra saldo negativo mesmo por SQL cru', async () => {
    const id = await openWallet('10.00');
    const update = orm.em
      .getConnection()
      .execute('update spike_wallets set balance = -1 where id = ?', [id]);

    await expect(update).rejects.toThrow(/spike_wallets_balance_non_negative/);
  });
});

describe('concorrência: duas apostas de 80.00 sobre saldo de 100.00', () => {
  test('controle negativo: sem lock, as duas leem 100.00 e há lost update', async () => {
    const id = await openWallet('100.00');
    const results = await Promise.allSettled([
      service.debit(id, '80.00', { locked: false, label: 'a' }),
      service.debit(id, '80.00', { locked: false, label: 'b' }),
    ]);

    // As duas leram antes de qualquer uma terminar: a disputa foi real.
    const t = service.timeline;
    expect(Math.max(at(t, 'a', 'read'), at(t, 'b', 'read'))).toBeLessThan(
      Math.min(at(t, 'a', 'end'), at(t, 'b', 'end')),
    );
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(await service.balanceOf(id)).toBe('20.00'); // 160.00 debitados, saldo de um só
  });

  test('com PESSIMISTIC_WRITE, a segunda espera o commit da primeira e é recusada', async () => {
    const id = await openWallet('100.00');
    const results = await Promise.allSettled([
      service.debit(id, '80.00', { locked: true, label: 'a' }),
      service.debit(id, '80.00', { locked: true, label: 'b' }),
    ]);

    const winner = results[0]!.status === 'fulfilled' ? 'a' : 'b';
    const loser = winner === 'a' ? 'b' : 'a';
    const t = service.timeline;

    // As duas transações estavam abertas ao mesmo tempo...
    expect(Math.max(at(t, 'a', 'begin'), at(t, 'b', 'begin'))).toBeLessThan(at(t, winner, 'end'));
    // ...e a perdedora só conseguiu ler depois do commit da vencedora.
    expect(at(t, loser, 'read')).toBeGreaterThanOrEqual(at(t, winner, 'end') - 5);

    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(InsufficientFundsError);
    expect(await service.balanceOf(id)).toBe('20.00');
  });
});

describe('NestJS 12 sobre Bun', () => {
  test('injeção por tipo de construtor e rota HTTP real', async () => {
    const id = await openWallet('42.50');
    const response = await fetch(`${await app.getUrl()}/spike/wallets/${id}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id, balance: '42.50' });
  });
});
