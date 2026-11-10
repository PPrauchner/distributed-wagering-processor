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
a aritmética usa centavos em `bigint` — nunca `number`. A moeda repetida é amarrada
no schema: na carteira, um `CHECK` iguala `currency` e `balance_currency`; no
lançamento, um `CHECK` iguala as três moedas e uma FK composta
`(wallet_id, currency) → wallets(id, currency)` exige que sejam a da carteira. A
garantia vale para o **lançamento**, não para a transação de aposta: esta pode
chegar com outra moeda e é persistida como `REJECTED` (`CURRENCY_MISMATCH`) —
quem barra a operação é o domínio, sob lock. Ver
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
lock. `version` é contador monotônico, não lock otimista.

Não há deadlock por uma regra de ordem: **o lock da carteira é o primeiro lock de
toda transação SQL que toca uma carteira**. Por isso os workers (referências
pendentes e publicador da outbox) reivindicam itens com um **lease** numa transação
SQL curta e separada (`FOR UPDATE SKIP LOCKED` + `next_attempt_at = now() + lease`,
com commit) e processam cada item numa unidade de trabalho própria, que começa pela
carteira. Worker morto: o lease expira e outra instância assume. Ver
[ADR 0002](docs/adr/0002-lock-pessimista-por-carteira.md).

## Invariantes no schema

*A definir* — tabela das constraints, índices e triggers: unicidade (carteira por
jogador e moeda, id externo por provedor, chave de idempotência, inbox, um
lançamento por transação e carteira, uma reversão por referência), imutabilidade
do livro-razão, saldo não negativo, moeda repetida amarrada por `CHECK`.

Previsto para a unicidade da reversão: índice único parcial em
`reference_transaction_id` com
`WHERE status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK')` — ver
[Reembolso e reversão](#reembolso-e-reversão).

## Reembolso e reversão

**Interpretação adotada do §7, regra 4.** O enunciado proíbe desfazer uma
referência duas vezes "pelo mesmo tipo de operação", o que permitiria um `REFUND` e
um `ROLLBACK` da mesma `BET` — devolvendo o valor da aposta duas vezes. Aqui uma
referência só pode ser desfeita **uma vez, por qualquer tipo**: o segundo desfazer
é `REJECTED` (`REFERENCE_ALREADY_REVERSED`). Desfazer um reembolso indevido se faz
com a reversão *do reembolso*, não com um segundo desfazer da aposta.

Consequência, aceita: na sequência `BET` → `REFUND` → `ROLLBACK` do `REFUND`, a
aposta volta a valer, mas não pode mais ser reembolsada nem revertida — ela já foi
desfeita uma vez.

## Idempotência e deduplicação

- **A chave de idempotência é única por provedor:**
  `UNIQUE (provider_id, idempotency_key)`. Dois provedores podem usar a mesma
  chave sem colidir; o replay é buscado por provedor e chave.
- **Id externo reusado com outra chave é conflito** (`EXTERNAL_ID_CONFLICT`), com
  o mesmo desfecho HTTP do conflito de idempotência: nada é persistido e não há
  replay do resultado da outra chave. O use case consulta
  `(provider_id, external_transaction_id)` antes de inserir; a corrida entre
  carteiras diferentes, que não compartilham lock, cai no `23505` dessa constraint
  e é classificada como o mesmo conflito. Na fila, é erro de negócio terminal.

### Submissões não admitidas

Toda submissão que **não vira transação de aposta** é gravada numa tabela própria,
append-only e sem FK: payload inválido (HTTP ou fila), carteira inexistente,
`OPENING` vindo de fora, conflito de idempotência e `EXTERNAL_ID_CONFLICT`. Colunas:
`provider_id`, `idempotency_key`, `external_transaction_id`, `payload_hash`, código
de falha, canal, `message_id` (quando houver) e `received_at` — o que der para
extrair, já que um payload inválido pode não ter chave. O insert roda numa unidade
de trabalho própria, no ponto da recusa; sem unicidade (cada tentativa é uma linha).
Replays não entram: são métrica.

Com isso, `wager_transactions.wallet_id` mantém a FK `NOT NULL`: a carteira
inexistente responde `WALLET_NOT_FOUND` (HTTP 422; na fila, `ack`), sem evento e
sem `transactionId`, e um reenvio depois que a carteira existir é processado
normalmente. Carteira de outro jogador é outra coisa: a FK é satisfeita, e a
transação é `REJECTED` (`WALLET_PLAYER_MISMATCH`), com evento.

*A definir* — camadas de deduplicação (inbox por `(consumerName, messageId)`),
replay × conflito de payload, algoritmo do `payloadHash`.

## Classificação de falhas

Erros do banco passam por um classificador único, por SQLSTATE e nome da
constraint: lock e serialização são transitórios; violação de `CHECK`, FK de moeda
ou trigger do livro-razão é permanente (`FAILED`). `REJECTED` vem só do domínio. Ver
[ADR 0001](docs/adr/0001-mikroorm-7-com-invariantes-no-schema.md).

Unicidade violada (`23505`): se a disputa escapa do lock da carteira, é desfecho
legítimo; se o lock a serializa, o domínio teria visto antes, e é bug.

| Constraint | Categoria |
|---|---|
| `wallets (player_id, currency)` | conflito → 409 `WALLET_ALREADY_EXISTS` |
| `(provider_id, idempotency_key)` | relê e compara o hash → replay ou conflito |
| `(provider_id, external_transaction_id)` | conflito → `EXTERNAL_ID_CONFLICT` |
| `inbox (consumer_name, message_id)` | redelivery → `ack` sem efeito |
| reversão única por referência | bug → permanente (`FAILED`, alerta) |
| lançamento `(transaction_id, wallet_id)` | bug → permanente (`FAILED`, alerta) |

**Quem grava `FAILED`: o consumidor.** Como a transação SQL do erro permanente já
sofreu rollback, uma **segunda unidade de trabalho** grava a transação de aposta
como `FAILED`, com o código de falha, e o inbox, pela chave de idempotência; depois
a mensagem é enviada explicitamente à DLQ e apagada da fila principal (se a remoção
falhar, a redelivery é reconhecida pelo inbox).

- **Transitório:** sem `ack`; backoff por `ChangeMessageVisibility`. Esgotadas as
  tentativas (`ApproximateReceiveCount`) com o banco de pé, vira permanente
  (`INFRA_RETRIES_EXHAUSTED`).
- **Payload inválido na fila:** direto à DLQ, sem gravar transação — não há chave
  nem hash confiáveis —, com log, métrica e uma linha de
  [submissão não admitida](#submissões-não-admitidas).

*A definir* — valores do limite de tentativas e do backoff.

## Mensageria: SQS, inbox e outbox

*A definir* — consumidor (ack após commit, DLQ, `SIGTERM`), publicador da outbox
com vários publishers concorrentes, recuperação após queda.

## Referências fora de ordem

Só o worker resolve uma transação `PENDING_REFERENCE`, reivindicada por lease (ver
[Concorrência](#concorrência)); a chegada da referência não a resolve na hora.
Resolver na hora seria seguro, mas é escopo extra — fica como melhoria possível, e a
latência da pendente é limitada pelo intervalo do worker.

*A definir* — intervalo, backoff exponencial e limite de tentativas ou TTL.

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
- Com o PostgreSQL fora até o fim das tentativas, o redrive do SQS leva a mensagem
  à DLQ sem desfecho gravado: a transação de aposta não existe. Reprocessar a DLQ é
  seguro pela idempotência.
- `FAILED` é terminal para a chave de idempotência, inclusive quando a causa foi um
  bug: corrigido o bug, o provedor reenvia com uma chave nova.
