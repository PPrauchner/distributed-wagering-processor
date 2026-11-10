/**
 * Mapeamento da carteira do spike, na infraestrutura: o domínio não sabe que ele
 * existe. Campos `private` do TypeScript são propriedades comuns em runtime, então
 * o ORM os lê e escreve sem o domínio expor setters.
 *
 * @packageDocumentation
 */
import { defineEntity, p, type EntityCtor } from '@mikro-orm/core';
import { SpikeWallet } from './spike-wallet.ts';

// O tipo `EntityCtor` exige construtor público, mas o domínio usa construtor
// privado + factories. Em runtime o MikroORM hidrata sem chamar o construtor
// (Object.create no protótipo), então a coerção é só de tipo e fica confinada
// a este arquivo de mapeamento.
const SpikeWalletClass = SpikeWallet as unknown as EntityCtor<SpikeWallet>;

export const SpikeWalletSchema = defineEntity({
  class: SpikeWalletClass,
  tableName: 'spike_wallets',
  properties: {
    id: p.uuid().primary(),
    _balance: p.decimal('string').precision(19).scale(2).fieldName('balance'),
    _version: p.integer().fieldName('version'),
  },
});
