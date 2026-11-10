# Arquitetura — Distributed Wagering Processor

Decisões, trade-offs e limitações da solução. Este documento é o mapa: cada seção
resume a decisão e aponta para o ADR que guarda o porquê completo
(`docs/adr/`). O vocabulário segue o glossário em `CONTEXT.md`.

> **Esqueleto em construção.** Seções marcadas *A definir* ainda não foram
> decididas; cada decisão nova atualiza a seção correspondente.

## Visão geral

*A definir* — componentes (API HTTP, consumidor SQS, publicador da outbox, worker
de referências pendentes), fluxo de uma transação de aposta da entrada ao evento
publicado, e como várias instâncias convivem.

## Organização do código

`src/` é dividido em módulos (`shared`, `wallet`, `wagering`, `messaging`,
`health`), cada um com as camadas `domain/`, `application/`, `infrastructure/` e
`interface/`, com dependência apontando só para dentro. O domínio não importa ORM
nem NestJS.

## Persistência e ORM

**MikroORM 7**, com as classes de domínio mapeadas por `defineEntity` na
infraestrutura e migrations programáticas por script Bun. Ver
[ADR 0001](docs/adr/0001-mikroorm-7-com-invariantes-no-schema.md).

- **Desvio declarado do §6.0 do enunciado:** o MikroORM hidrata as entidades por
  `Object.create`, sem passar pela factory `rehydrate`. A garantia do §6.0 se
  mantém — reidratar não revalida transições —, e o `rehydrate` existe para
  reconstrução fora do ORM. Registros de persistência separados com mapper
  cumpririam a letra, ao custo do Unit of Work e do Identity Map.
- Campos privados do domínio são mapeados apontando para o getter público
  (`accessor`), para que as consultas usem o nome do domínio, com tipo.
- O construtor privado só atribui parâmetros: validação e valores iniciais moram
  nas factories.

## Mapeamento do `Money`

`Money` é um embeddable: cada valor ocupa `<prefixo>_amount numeric(19,2)` e
`<prefixo>_currency`. O estado interno é a string decimal exata que vai à coluna, e
a aritmética usa centavos em `bigint` — nunca `number`. A moeda repetida no
lançamento é amarrada por `CHECK` e por FK composta `(wallet_id, currency)`, o que
põe a regra "moeda da operação = moeda da carteira" no schema. Ver
[ADR 0001](docs/adr/0001-mikroorm-7-com-invariantes-no-schema.md).

## Estratégia transacional

Cada use case abre a própria unidade de trabalho por uma porta `UnitOfWork`; a
infraestrutura a implementa com `em.fork().transactional()`. Transação de aposta,
saldo, lançamento, inbox e evento da outbox são confirmados juntos numa única
transação SQL. Vale igual para HTTP, fila e workers. Ver
[ADR 0001](docs/adr/0001-mikroorm-7-com-invariantes-no-schema.md).

## Concorrência

Lock pessimista na linha da carteira (`SELECT … FOR UPDATE`), primeiro passo de
cada unidade de trabalho que move saldo; uma carteira por transação, sem lock
global. `lock_timeout` de 2 s: estourar é erro transitório e conta como conflito de
lock. `version` é contador monotônico, não lock otimista. Ver
[ADR 0002](docs/adr/0002-lock-pessimista-por-carteira.md).

## Invariantes no schema

*A definir* — tabela das constraints, índices e triggers: unicidade (carteira por
jogador e moeda, id externo por provedor, chave de idempotência, inbox, um
lançamento por transação e carteira), imutabilidade do livro-razão, saldo não
negativo.

## Idempotência e deduplicação

*A definir* — camadas de deduplicação (chave de idempotência, inbox por
`(consumerName, messageId)`), replay × conflito de payload.

## Classificação de falhas

Erros do banco passam por um classificador único, por SQLSTATE e nome da
constraint: lock e serialização são transitórios; duplicata de idempotência ou
inbox é replay ou conflito; violação de `CHECK`, FK de moeda ou trigger do
livro-razão é permanente (`FAILED`). `REJECTED` vem só do domínio. Ver
[ADR 0001](docs/adr/0001-mikroorm-7-com-invariantes-no-schema.md).

*A definir* — política de retry, backoff e limite de tentativas antes da DLQ.

## Mensageria: SQS, inbox e outbox

*A definir* — consumidor (ack após commit, DLQ, `SIGTERM`), publicador da outbox
com vários publishers concorrentes, recuperação após queda.

## Referências fora de ordem

*A definir* — `PENDING_REFERENCE` e o worker que as resolve.

## Autenticação

Fora do escopo implementado, como o §2 do enunciado permite: guard no-op atrás de
uma porta de identidade do provedor. *A definir* — o desenho que seria adotado com
Keycloak.

## Observabilidade

*A definir* — logs estruturados, métricas, health checks.

## Limitações conhecidas

- `orderBy` pelo nome do getter (`accessor`) falha em runtime no MikroORM 7.2.8;
  ordenação por estado privado fica no repositório.
- O conversor de erros do MikroORM para PostgreSQL não mapeia o estouro de
  `lock_timeout` (`55P03`); ele é reconhecido pelo código.
- A vazão de uma única carteira é limitada pela duração da transação, por causa do
  lock pessimista.
