---
status: proposed
---

# MikroORM 7, mapeado fora do domínio, com as invariantes no schema

Usamos **MikroORM 7** como ORM, com as entidades mapeadas por `defineEntity` na
camada de infraestrutura — o domínio não importa nada do ORM —, migrations
executadas programaticamente por um script Bun e entidades registradas
explicitamente. As garantias financeiras (unicidade, imutabilidade do livro-razão,
saldo não negativo) moram no schema do PostgreSQL, não no ORM.

MikroORM é o preferido do enunciado e oferece Unit of Work, Identity Map,
`em.transactional()` e lock pessimista, que casam com o desenho de travar a carteira
dentro de uma única transação SQL. A versão 7 desacoplou o core e os drivers do
Node e tornou `defineEntity` o caminho recomendado, o que reduz o atrito com Bun e
dispensa decorators no domínio.

O status fica **proposto** até um spike provar a combinação Bun + NestJS 12 +
MikroORM 7 + PostgreSQL: uma entidade, migration de ida e volta via script, uma
transação SQL com `PESSIMISTIC_WRITE` e um teste rodando em `bun test`. Passando,
vira **aceito**.

## Considered Options

- **TypeORM 1.x** — aceito pelo enunciado, mas sem Unit of Work nem Identity Map,
  recém-saído de uma major com quebras (inclusive nos modos de lock pessimista) e
  sem vantagem de compatibilidade com Bun.
- **MikroORM 6** — a geração anterior ainda depende de Knex e de `ts-node` no CLI.

## Consequences

- O CLI do MikroORM ainda exige Node; não o usamos — migrations rodam pelo
  `migrator` a partir de um script Bun, com a lista de migrations explícita.
- Fora de requisições HTTP (consumidor da fila, publicador da outbox, worker de
  referências pendentes), cada unidade de trabalho usa seu próprio `EntityManager`
  bifurcado (`em.fork()`), para não compartilhar Identity Map entre mensagens.
- Como as invariantes estão no schema e o domínio é puro, trocar de ORM afeta só a
  camada de persistência.
