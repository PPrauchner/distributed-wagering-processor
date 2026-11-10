---
status: accepted
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

## Spike (10/11/2026)

Aceito depois do spike em `spike/` (Bun 1.4.4, NestJS 12.4, MikroORM 7.2.8,
TypeScript 6.0, PostgreSQL 17), com testes contra banco real, estáveis em execuções
repetidas:

- migrations de ida e volta pelo `migrator`, num script Bun, sem o CLI;
- classe de domínio com construtor privado, mapeada por `defineEntity`, hidratada
  como instância da classe e com o `numeric(19,2)` lido como string exata;
- `CHECK (balance >= 0)` barrando saldo negativo mesmo por SQL cru;
- duas transações SQL simultâneas debitando 80.00 de 100.00: sem lock há lost
  update (controle negativo); com `PESSIMISTIC_WRITE` a segunda espera o commit da
  primeira e é recusada, saldo final 20.00 — a linha do tempo das transações prova
  que a disputa foi real;
- injeção de dependência por tipo de construtor e rota HTTP do NestJS rodando sobre
  Bun.

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
- O tipo `EntityCtor` do `defineEntity` exige construtor público. Como o domínio usa
  construtor privado + factories, o arquivo de mapeamento faz uma coerção de tipo
  da classe (`as unknown as EntityCtor<T>`). Em runtime o MikroORM hidrata sem
  chamar o construtor; a coerção fica confinada à infraestrutura.
- Estado do domínio usa campos `private` do TypeScript, não `#private` do
  JavaScript: o ORM precisa ler e escrever essas propriedades.
- TypeScript fixado em 6.0 (o 7.0 nativo é recente demais para garantir decorators
  com metadados, de que o NestJS depende).
- A conexão com o banco usa `127.0.0.1`, não `localhost`: no Windows o `localhost`
  tenta IPv6 primeiro e cada conexão nova leva ~300 ms, o que serializa transações
  por acaso e faz um teste de concorrência passar sem disputa real.
- Como as invariantes estão no schema e o domínio é puro, trocar de ORM afeta só a
  camada de persistência.
