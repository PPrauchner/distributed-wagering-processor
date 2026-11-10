/**
 * Serviço Nest do spike: injeta o EntityManager do MikroORM e debita a carteira
 * dentro de uma transação SQL, com ou sem lock pessimista na linha. Registra a
 * linha do tempo de cada transação para o teste provar que houve disputa real.
 *
 * @packageDocumentation
 */
import { Controller, Get, Injectable, Module, Param } from '@nestjs/common';
import { EntityManager, LockMode } from '@mikro-orm/postgresql';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { SpikeWallet } from './spike-wallet.ts';
import { spikeOrmConfig } from './orm.config.ts';

/** Atraso entre ler e gravar, para alargar a janela de corrida. */
export const RACE_WINDOW_MS = 150;

export type TimelinePhase = 'begin' | 'read' | 'end';

export interface TimelineEvent {
  label: string;
  phase: TimelinePhase;
  at: number;
}

@Injectable()
export class SpikeWalletService {
  readonly timeline: TimelineEvent[] = [];

  constructor(private readonly em: EntityManager) {}

  /**
   * Debita a carteira numa transação SQL própria.
   *
   * @param walletId - Carteira a debitar.
   * @param amount - Valor decimal com duas casas.
   * @param options - `locked` usa `SELECT … FOR UPDATE`; `label` identifica a
   *   transação na linha do tempo.
   * @returns O saldo depois do débito.
   * @throws {@link InsufficientFundsError} Se o saldo lido não cobre o débito.
   */
  async debit(
    walletId: string,
    amount: string,
    options: { locked: boolean; label: string },
  ): Promise<string> {
    const mark = (phase: TimelinePhase): void => {
      this.timeline.push({ label: options.label, phase, at: performance.now() });
    };
    try {
      return await this.em.fork().transactional(async (tx) => {
        await tx.getConnection().execute('select 1', [], 'all', tx.getTransactionContext());
        mark('begin');
        const wallet = await tx.findOneOrFail(SpikeWallet, walletId, {
          lockMode: options.locked ? LockMode.PESSIMISTIC_WRITE : undefined,
        });
        mark('read');
        await Bun.sleep(RACE_WINDOW_MS);
        wallet.debit(amount);
        return wallet.balance;
      });
    } finally {
      mark('end');
    }
  }

  /**
   * Lê o saldo de uma carteira.
   *
   * @param walletId - Carteira a consultar.
   * @returns O saldo como string decimal.
   */
  async balanceOf(walletId: string): Promise<string> {
    const wallet = await this.em.fork().findOneOrFail(SpikeWallet, walletId);
    return wallet.balance;
  }
}

@Controller('spike/wallets')
export class SpikeWalletController {
  constructor(private readonly service: SpikeWalletService) {}

  @Get(':id')
  async show(@Param('id') id: string): Promise<{ id: string; balance: string }> {
    return { id, balance: await this.service.balanceOf(id) };
  }
}

@Module({
  imports: [MikroOrmModule.forRoot({ ...spikeOrmConfig, registerRequestContext: false })],
  controllers: [SpikeWalletController],
  providers: [SpikeWalletService],
})
export class SpikeModule {}
