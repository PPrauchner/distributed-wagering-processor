/**
 * `Money` mapped as an embeddable: each value takes two columns,
 * `<prefix>amount numeric(19,2)` and `<prefix>currency`. The amount is read
 * back as the exact decimal string, never as a JS number (ADR 0001).
 *
 * @packageDocumentation
 */
import { defineEntity, p, type EntityCtor } from '@mikro-orm/core';
import { Money } from '../domain/money.ts';

// `EntityCtor` requires a public constructor; the domain uses a private one plus
// factories. The ORM hydrates through the prototype, so the cast is type-only and
// stays confined to the mapping.
const MoneyClass = Money as unknown as EntityCtor<Money>;

export const MoneySchema = defineEntity({
  class: MoneyClass,
  embeddable: true,
  properties: {
    _amount: p.decimal('string').precision(19).scale(2).fieldName('amount'),
    currency: p.string().length(3),
  },
});
