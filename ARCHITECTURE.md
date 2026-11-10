# Arquitetura — Distributed Wagering Processor

Decisões, trade-offs e limitações da solução. Este documento é o mapa: cada seção
resume a decisão e aponta para o ADR que guarda o porquê completo
(`docs/adr/`). O vocabulário segue o glossário em `CONTEXT.md`.

> **Esqueleto em construção.** Seções marcadas *A definir* ainda não foram
> decididas; cada decisão nova atualiza a seção correspondente.

## Visão geral

Um único serviço NestJS, rodando em várias instâncias idênticas sobre o mesmo
PostgreSQL e as mesmas filas. Cada instância tem quatro componentes:

- **API HTTP** — submissão de transações, carteiras, consultas, reconciliação,
  health e métricas;
- **consumidor SQS** — lê `wager-transactions.fifo` e chama **o mesmo use case** da
  API;
- **worker de referências pendentes** — resolve transações `PENDING_REFERENCE`;
- **publicador da outbox** — publica os eventos de integração em
  `wagering-events.fifo`.

Fluxo de uma transação de aposta: a entrada (HTTP ou fila) valida o payload e
calcula o hash do payload; o use case abre uma unidade de trabalho, trava a
carteira, resolve idempotência e referência, aplica a regra de negócio e confirma
transação, saldo, lançamento, inbox e evento da outbox numa única transação SQL; o
publicador, depois do commit, leva o evento à fila de eventos.

**A submissão HTTP é síncrona:** a resposta já traz o desfecho (`PROCESSED` ou
`REJECTED`, com saldo); o único aceite pendente é `PENDING_REFERENCE` (202).
`PENDING` existe só em memória dentro da unidade de trabalho — nenhum caminho o
persiste, e o schema o proíbe. *Alternativa considerada:* aceitar e processar
depois (202 + worker). Ganharia requisições que não esperam o lock e absorção de
pico, mas contraria o contrato do §9 (resposta com desfecho e saldo; replay com o
saldo observado), obriga o provedor a consultar em loop para saber se a `BET`
passou e tira o determinismo dos testes. Fica como evolução para carteiras muito
disputadas.

As instâncias convivem sem coordenação além do banco: lock por carteira, inbox e
chave de idempotência persistentes, e workers que reivindicam itens com lease e
`SKIP LOCKED`.

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
- Identificadores em UUIDv7, gerados na aplicação; datas em `timestamptz`.

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

**Validação na entrada:** `amount` com até 15 dígitos inteiros e exatamente 2 casas
(máximo `"999999999999999.99"`), o que deixa duas ordens de grandeza de folga até a
coluna; moeda no formato `^[A-Z]{3}$`, sem lista ISO completa. Nada é arredondado:
mais de 2 casas é recusado (`INVALID_PAYLOAD`) — é a leitura adotada para o
"arredondamento" do §13. Piso por tipo: `BET`, `WIN`, `REFUND` e `ROLLBACK` maiores
que zero; `LOSS` e `initialBalance` zero ou mais; o `CHECK` do banco repete as
regras.

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

| Tabela | Garantias |
|---|---|
| `wallets` | `CHECK (balance_amount >= 0)`, `CHECK (version >= 1)`, `CHECK (currency = balance_currency)`; `UNIQUE (player_id, currency)`; `UNIQUE (id, currency)` (alvo da FK de moeda); `UNIQUE (creation_idempotency_key)` (anulável) e `CHECK` de chave e hash da criação ambos nulos ou ambos preenchidos; `initial_balance` |
| `wager_transactions` | `UNIQUE (provider_id, idempotency_key)`; `UNIQUE (provider_id, external_transaction_id)`; FK `wallet_id NOT NULL`; FK `reference_transaction_id` na própria tabela; índice único parcial da reversão; `CHECK`s de coerência (`REFUND`/`ROLLBACK` ⇒ referência externa preenchida, `BET`/`LOSS`/`OPENING` ⇒ nula, `WIN` livre; `PENDING_REFERENCE` só para `REFUND`, `ROLLBACK` e `WIN`; `PROCESSED` ⇔ `processed_at`; `REJECTED`/`FAILED` ⇔ `failure_code`; `PROCESSED`/`REJECTED` ⇔ `balance_after` e `wallet_version_observed` preenchidos; `status <> 'PENDING'`); `amount > 0`, exceto `LOSS` (`>= 0`); `correlation_id NOT NULL`; índice parcial `WHERE status = 'PENDING_REFERENCE'` |
| `wallet_ledger_entries` | `UNIQUE (transaction_id, wallet_id)`; `UNIQUE (wallet_id, wallet_version)`; FK composta e `CHECK` de moeda; `amount > 0`; `CHECK` da aritmética (`balance_after = balance_before ± amount` pela `direction`, saldos `>= 0`) |
| `inbox_messages` | PK `(consumer_name, message_id)` |
| `outbox_messages` | `wallet_id NOT NULL` (o `MessageGroupId`); índice parcial `WHERE published_at IS NULL` em `next_attempt_at` |
| `rejected_submissions` | append-only, sem FK nem unicidade; `correlation_id` anulável |

**Triggers:**

- **Livro-razão imutável:** `UPDATE`, `DELETE` e `TRUNCATE` em
  `wallet_ledger_entries` são recusados.
- **Saldo ↔ livro-razão:** *constraint trigger* deferido em `wallets` exige, no
  commit, um lançamento que leve do saldo antigo ao novo com a versão nova, e a
  versão subindo exatamente 1 quando o saldo muda. Ver
  [ADR 0003](docs/adr/0003-versao-da-carteira-como-sequencia-do-livro-razao.md).
- **Transação terminal imutável:** em `wager_transactions`, linha em `PROCESSED`,
  `REJECTED` ou `FAILED` não muda; colunas de identidade (chave, hash, valor, tipo,
  carteira, `correlation_id`…) não mudam em estado nenhum; nenhuma linha é apagada.
  O único `UPDATE` de status aceito parte de `PENDING_REFERENCE`.
- **Identidade da carteira imutável:** em `wallets`, `player_id`, `currency`,
  `initial_balance` e chave e hash da criação não mudam.

Tempos que dependem de relógio — TTL das pendentes e leases dos workers — usam o
`now()` do banco, nunca o relógio da instância.

Unicidade da reversão: índice único parcial em `reference_transaction_id` com
`WHERE status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK')` — ver
[Reembolso e reversão](#reembolso-e-reversão).

## Carteira e livro-razão

- **Criação:** saldo inicial zero é permitido — sem abertura nem lançamento,
  `version` 1. Saldo positivo gera a abertura (`OPENING`, `provider_id` =
  `internal`, chave `opening:<walletId>`) já `PROCESSED`, com lançamento `CREDIT`
  e os eventos `WagerTransactionProcessed` e `WalletBalanceChanged`, na mesma
  transação SQL.
- **Criação idempotente, com header opcional:** o `POST /wallets` aceita
  `Idempotency-Key`. Mesma chave e mesmo hash (`playerId` e `initialBalance`, pela
  mesma função canônica) → replay da resposta original (201, saldo inicial, `version`
  1, `idempotentReplay: true`); hash diferente → 409 `IDEMPOTENCY_CONFLICT`. Sem o
  header, vale o contrato do §9 sem mudança — obrigatório, um cliente que segue o
  enunciado receberia 400. Em qualquer caso, carteira já existente para jogador e
  moeda → 409 `WALLET_ALREADY_EXISTS` **com o `walletId`**, para que o provedor que
  perdeu o 201 descubra a carteira. A chave da criação é global, porque a carteira não
  tem provedor (limitação; com autenticação, seria por provedor).
- **Sequência:** cada lançamento guarda a versão da carteira depois dele; as
  versões são contínuas até a atual, começando em 1 com abertura e em 2 sem ela.
  Ver [ADR 0003](docs/adr/0003-versao-da-carteira-como-sequencia-do-livro-razao.md).
- **Paginação:** ordem crescente, cursor opaco
  `base64url("v1:<walletId>:<wallet_version>")`; `limit` padrão 50, máximo 200.
  Cursor malformado ou de outra carteira → 400 `INVALID_CURSOR`; `limit` fora de
  1..200 ou não numérico → 400 `INVALID_PAYLOAD`. Resposta `{ items, nextCursor }`,
  com `nextCursor` nulo na última página; cada item traz `id`, `transactionId`,
  `direction`, `money`, `balanceBefore`, `balanceAfter`, `walletVersion` e
  `createdAt`. Páginas já servidas nunca mudam.
- **Reconciliação** (`POST /wallets/:walletId/reconciliation`): só leitura, sem
  lock, numa única consulta (snapshot consistente) — saldo, soma com sinal dos
  lançamentos, contagem e buracos na sequência. A resposta do §9 ganha
  `versionGaps`. Divergência de valor ou buraco → `consistent: false`, log `error`
  e métrica; nada é corrigido; HTTP 200, porque o achado é o relatório.

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

**Referência do ganho.** O `WIN` pode citar a `BET` da rodada (§7). Quando cita, a
referência é resolvida como a de uma transação dependente — tem de ser uma `BET`
`PROCESSED` do mesmo provedor, jogador, carteira, moeda e rodada, e, ausente, o
`WIN` fica `PENDING_REFERENCE` à espera do worker. Mas o `WIN` não é transação
dependente: o valor é livre (o prêmio não iguala a aposta) e citar não é desfazer —
vários `WIN` podem citar a mesma `BET`, fora do índice de reversão única. A `LOSS`
não aceita referência.

| | `REFUND` | `ROLLBACK` | `WIN` |
|---|---|---|---|
| referência | obrigatória | obrigatória | opcional |
| tipo aceito | `BET` | `BET`, `WIN`, `REFUND` | `BET` |
| valor igual ao da referência | sim | sim | não |
| conta como desfazer (uma vez) | sim | sim | não |

**Rodada sem máquina de estados** (interpretação adotada): `WIN` sem `BET`, ou `WIN`
e `LOSS` na mesma rodada, são aceitos; a rodada só entra na coerência da referência.

## Transições da transação de aposta

| De | Para | Quando |
|---|---|---|
| *(create)* | `PENDING` | em memória; nunca persistido |
| `PENDING` | `PROCESSED` / `REJECTED` | a regra de negócio passa / recusa |
| `PENDING` | `PENDING_REFERENCE` | a referência ainda não existe (`REFUND`, `ROLLBACK`, `WIN` com referência) |
| `PENDING` | `FAILED` | erro permanente, gravado na segunda unidade de trabalho |
| `PENDING_REFERENCE` | `PROCESSED` / `REJECTED` | o worker resolve, ou o TTL expira (`REFERENCE_NOT_FOUND`) |
| `PENDING_REFERENCE` | `FAILED` | erro permanente durante a resolução |
| `PROCESSED`, `REJECTED`, `FAILED` | — | `InvalidTransactionStateError`: erro de programação |

A primeira gravação já sai em `PROCESSED`, `REJECTED`, `PENDING_REFERENCE` ou
`FAILED`. `markPendingReference` só parte de `PENDING`: a pendente que continua
esperando só é reagendada, sem mudar de estado. A abertura segue `create` →
`markProcessed`.

## Ordem das validações

Com mais de uma violação, prevalece a primeira, na mesma ordem nos dois canais:

1. Chave ausente → `MISSING_IDEMPOTENCY_KEY` (na fila, `INVALID_PAYLOAD`).
2. Forma do payload (campo desconhecido, `Money` inválido, `kind` fora do enum,
   referência obrigatória ausente ou proibida presente) → `INVALID_PAYLOAD`;
   `OPENING` bem formado → `INTERNAL_KIND_NOT_ALLOWED`.
3. Hash do payload.
4. Idempotência por provedor e chave, sem lock → replay ou `IDEMPOTENCY_CONFLICT`.
   Vem antes da carteira: chave reusada com carteira inexistente é conflito.
5. Id externo com outra chave → `EXTERNAL_ID_CONFLICT`.
6. Lock da carteira; inexistente → `WALLET_NOT_FOUND`.
7. Passos 4 e 5 de novo, sob lock — uma concorrente pode ter confirmado.
8. Domínio: `WALLET_PLAYER_MISMATCH`; `CURRENCY_MISMATCH`; referência (ausente ou
   ela mesma pendente → espera; `REFERENCE_NOT_PROCESSED`;
   `REFERENCE_KIND_NOT_ALLOWED`; `REFERENCE_MISMATCH`, citando o primeiro campo
   divergente na ordem provedor, jogador, carteira, moeda, rodada;
   `REFERENCE_AMOUNT_MISMATCH`, exceto no `WIN`; `REFERENCE_ALREADY_REVERSED`, só na
   transação dependente); saldo (`INSUFFICIENT_FUNDS` ou
   `REVERSAL_INSUFFICIENT_FUNDS`).

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
- **Camadas:** o inbox, por `(consumerName, messageId)`, protege contra a
  redelivery da fila; a chave de idempotência protege contra o reenvio do provedor,
  por qualquer canal.
- **Replay** (mesma chave, mesmo hash) devolve o resultado original, com o mesmo
  código HTTP e `idempotentReplay: true`. O saldo observado vem de
  `wager_transactions.balance_after`, gravado com o saldo lido sob lock em todo
  desfecho `PROCESSED` ou `REJECTED` — inclusive `LOSS` e rejeições, que não têm
  lançamento, e `CURRENCY_MISMATCH`, em que é o saldo na moeda da carteira; junto,
  `wallet_version_observed`. Os dois ficam nulos em `PENDING_REFERENCE` e
  `FAILED`. Para transação ainda
  `PENDING_REFERENCE`, devolve o **estado atual** — se o worker já a resolveu, o
  desfecho final. **Conflito** (mesma chave, hash diferente) → 409.

### Hash do payload

SHA-256, em hex minúsculo (64 caracteres), de um JSON canônico — chaves ordenadas
recursivamente, sem espaços, UTF-8 — com os campos de negócio: `providerId`,
`externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`,
`money` (`amount`, `currency`) e `referenceExternalTransactionId`, este omitido
quando ausente (nunca `null`). Ficam de fora a chave de idempotência, `messageId`,
`type`, `occurredAt` e headers: o reenvio pelo outro canal dá o mesmo hash e é
replay. O hash é calculado sobre o comando já validado; campo desconhecido no corpo
é 400, para que dois payloads diferentes nunca compartilhem hash. Uma única função,
comum às duas entradas.

### Submissões não admitidas

Toda submissão que **não vira transação de aposta** é gravada numa tabela própria,
append-only e sem FK: payload inválido (HTTP ou fila), carteira inexistente,
`OPENING` vindo de fora, conflito de idempotência, `EXTERNAL_ID_CONFLICT` e, na
fila, `MESSAGE_ID_CONFLICT`. Colunas: `provider_id`, `idempotency_key`,
`external_transaction_id`, `payload_hash`, código de falha, canal, `message_id`
(quando houver), `correlation_id` e `received_at` — o que der para
extrair, já que um payload inválido pode não ter chave. O insert roda numa unidade
de trabalho própria, no ponto da recusa; sem unicidade (cada tentativa é uma linha).
Replays não entram: são métrica.

Com isso, `wager_transactions.wallet_id` mantém a FK `NOT NULL`: a carteira
inexistente responde `WALLET_NOT_FOUND` (HTTP 422), sem evento e sem
`transactionId`, e um reenvio depois que a carteira existir é processado
normalmente.

**Na fila, toda submissão não admitida termina na DLQ** — o canal de "precisa de
atenção" desse caminho, já que a fila não tem resposta. `WALLET_NOT_FOUND` é
tratado antes como transitório (sem `ack`, mesmo backoff): cobre a corrida em que o
provedor cria a carteira por HTTP e manda a primeira `BET` pela fila; esgotados os 5
recebimentos (~30 s), envio explícito à DLQ, sem `FAILED`. Conflitos de idempotência
e de id externo e `OPENING` de fora vão direto à DLQ, como o payload inválido e o
`MESSAGE_ID_CONFLICT`. Todo envio à DLQ leva o atributo `failureCode` e uma linha
de submissão não admitida (no envio final, não a cada recebimento). O `ack` puro
fica para os desfechos de transação, que emitem evento: o "erro de negócio → `ack`"
do §10 vale para a rejeição, e a submissão não admitida não é rejeição. Carteira de outro jogador é outra coisa: a FK é satisfeita, e a
transação é `REJECTED` (`WALLET_PLAYER_MISMATCH`), com evento.

## Status HTTP

Uma tabela para todos os endpoints. 4xx: não reenvie igual; 503: reenvie com a
mesma chave.

| Situação | HTTP |
|---|---|
| `PROCESSED` (original ou replay) | 200 |
| carteira criada | 201 |
| `PENDING_REFERENCE` | 202 |
| payload inválido, `Idempotency-Key` ausente, `OPENING` de fora, cursor inválido | 400 |
| recurso inexistente num `GET` | 404 |
| conflito de idempotência, `EXTERNAL_ID_CONFLICT`, `WALLET_ALREADY_EXISTS` | 409 |
| `REJECTED` (original ou replay), `WALLET_NOT_FOUND` | 422 |
| `FAILED` / erro permanente | 500 |
| falha transitória (lock, deadlock, banco ou SQS fora) | 503 + `Retry-After` |

Desfechos de transação respondem com o resultado da transação (`transactionId`,
`status`, `failureCode`, saldo, `idempotentReplay`); erros sem transação respondem
`{ failureCode, message }` — o 409 `WALLET_ALREADY_EXISTS` acrescenta o `walletId`.
O `GET` de transação devolve o mesmo corpo do desfecho, mais os campos de
identidade, sem `idempotentReplay`. O 503 leva `Retry-After: 1` (segundos,
configurável).

## Códigos de falha

Enum fechado em `shared/domain`.

| Código | Categoria | O que o provedor faz |
|---|---|---|
| `INSUFFICIENT_FUNDS` | rejeição (422) | desiste; a aposta não cabe no saldo |
| `REVERSAL_INSUFFICIENT_FUNDS` | rejeição (422) | desiste; a reversão deixaria o saldo negativo — exige tratamento operacional |
| `CURRENCY_MISMATCH` | rejeição (422) | corrige a moeda numa transação nova |
| `WALLET_PLAYER_MISMATCH` | rejeição (422) | corrige jogador ou carteira numa transação nova |
| `REFERENCE_NOT_FOUND` | rejeição (422) | a referência não chegou em 5 min; verifica o próprio envio |
| `REFERENCE_NOT_PROCESSED` | rejeição (422) | desiste; a referência foi rejeitada ou falhou |
| `REFERENCE_KIND_NOT_ALLOWED` | rejeição (422) | desiste; o tipo da referência não admite esta transação dependente |
| `REFERENCE_MISMATCH` | rejeição (422) | corrige; provedor, jogador, carteira, moeda ou rodada divergem (campo no `message`) |
| `REFERENCE_AMOUNT_MISMATCH` | rejeição (422) | corrige o valor; reversão parcial não existe |
| `REFERENCE_ALREADY_REVERSED` | rejeição (422) | desiste; a referência já foi desfeita |
| `INVALID_PAYLOAD` | não admitida (400) | corrige o payload |
| `MISSING_IDEMPOTENCY_KEY` | não admitida (400) | envia o header |
| `INTERNAL_KIND_NOT_ALLOWED` | não admitida (400) | não envia `OPENING` |
| `INVALID_CURSOR` | não admitida (400) | usa o cursor devolvido pela API |
| `IDEMPOTENCY_CONFLICT` | não admitida (409) | usa uma chave nova para um payload novo |
| `EXTERNAL_ID_CONFLICT` | não admitida (409) | o id externo já tem outra chave; corrige |
| `WALLET_ALREADY_EXISTS` | não admitida (409) | usa a carteira existente |
| `WALLET_NOT_FOUND` | não admitida (422; fila: retry, depois DLQ) | cria a carteira e reenvia |
| `MESSAGE_ID_CONFLICT` | não admitida (fila → DLQ) | não reusa `messageId` com outro conteúdo |
| `NOT_FOUND` | consulta (404) | — |
| `INFRA_RETRIES_EXHAUSTED` | falha (500) | reenvia com chave nova depois de normalizado |
| `INFRA_INVARIANT_VIOLATION` | falha (500, alerta) | bug nosso; reenvia com chave nova depois da correção |
| `INFRA_UNEXPECTED` | falha (500) | idem |
| `TRANSIENT_LOCK_TIMEOUT` | transitório (503) | reenvia com a mesma chave após `Retry-After` |
| `TRANSIENT_UNAVAILABLE` | transitório (503) | idem |

## Classificação de falhas

Erros do banco passam por um classificador único, por SQLSTATE e nome da
constraint: lock e serialização são transitórios; violação de `CHECK`, FK de moeda
ou trigger é permanente (`FAILED`, `INFRA_INVARIANT_VIOLATION`). `REJECTED` vem só
do domínio. Ver [ADR 0001](docs/adr/0001-mikroorm-7-com-invariantes-no-schema.md).

Unicidade violada (`23505`): se a disputa escapa do lock da carteira, é desfecho
legítimo; se o lock a serializa, o domínio teria visto antes, e é bug.

| Constraint | Categoria |
|---|---|
| `wallets (player_id, currency)` | conflito → 409 `WALLET_ALREADY_EXISTS`, com `walletId` |
| `wallets (creation_idempotency_key)` | relê e compara o hash → replay ou conflito |
| `(provider_id, idempotency_key)` | relê e compara o hash → replay ou conflito |
| `(provider_id, external_transaction_id)` | conflito → `EXTERNAL_ID_CONFLICT` |
| `inbox (consumer_name, message_id)` | redelivery → `ack` sem efeito |
| reversão única por referência | bug → permanente (`FAILED`, alerta) |
| lançamento `(transaction_id, wallet_id)` | bug → permanente (`FAILED`, alerta) |
| lançamento `(wallet_id, wallet_version)` | bug → permanente (`FAILED`, alerta) |

Estouro numérico (`22003`) também é permanente (`INFRA_INVARIANT_VIOLATION`,
alerta): com o teto de entrada, só um saldo acumulado além de `numeric(19,2)` o
dispara.

**Quem grava `FAILED`: o use case**, nas duas entradas. Como a transação SQL do
erro permanente já sofreu rollback, uma **segunda unidade de trabalho** grava a
transação de aposta como `FAILED`, com o código de falha (e o inbox, quando a
entrada é a fila), pela chave de idempotência. No HTTP, a resposta é 500 com
`transactionId` e `failureCode`, e o replay devolve o mesmo 500. Na fila, a
mensagem é enviada explicitamente à DLQ e apagada da fila principal (se a remoção
falhar, a redelivery é reconhecida pelo inbox).

- **Transitório na fila:** sem `ack`; backoff por `ChangeMessageVisibility`
  (`min(2^receiveCount s, 60 s)`). Esgotados **5 recebimentos** com o banco de pé,
  vira permanente (`INFRA_RETRIES_EXHAUSTED`). O `maxReceiveCount` do redrive é
  **6**: rede de segurança para o banco fora do ar.
- **Payload inválido na fila:** direto à DLQ, sem gravar transação — não há chave
  nem hash confiáveis —, com log, métrica e uma linha de
  [submissão não admitida](#submissões-não-admitidas).

## Mensageria: SQS, inbox e outbox

### Consumidor

- Long polling de 20 s, lotes de até 10 mensagens processadas em paralelo,
  visibilidade de 30 s. O agrupamento FIFO por carteira é otimização; a correção
  vem do lock.
- **Inbox:** `consumerName` = `wager-transactions-consumer`; `messageId` do
  envelope (não o `MessageId` do SQS); `payloadHash` pela mesma função do hash do
  payload, sobre `data`. Gravado na transação SQL de todo desfecho. Mesmo
  `messageId` com hash diferente → DLQ, `MESSAGE_ID_CONFLICT`. Submissões não
  admitidas não gravam inbox: terminam na DLQ, com linha em `rejected_submissions`
  (ver [Submissões não admitidas](#submissões-não-admitidas)).
- `ack` (`DeleteMessage`) só depois do commit.
- **`SIGTERM`:** para o polling e as reivindicações dos workers; espera as
  mensagens em andamento por até 20 s (`stop_grace_period` de 30 s no Compose);
  devolve as não iniciadas com visibilidade 0; fecha HTTP e pool. Se o prazo
  estourar, a transação SQL é atômica e a redelivery é segura; leases expiram.

### Publicador da outbox

- **Destino:** `wagering-events.fifo`; `MessageGroupId` = `walletId`,
  `MessageDeduplicationId` = `eventId` (otimização do broker, não garantia).
- **Publicado** = `SendMessageBatch` com sucesso para o item; `published_at` é
  gravado numa transação SQL curta. Se a instância morre entre o envio e a gravação,
  o lease expira e outra reenvia: **at-least-once**, e o consumidor deduplica pelo
  `eventId`, estável desde o `enqueue`.
- Polling a cada 500 ms, lotes de até 10, lease de 30 s. Falha → `scheduleRetry`
  com `min(1 s × 2^attempts, 5 min)` e jitter. **Sem limite de tentativas** —
  desistir perderia evento confirmado; a partir de 10 tentativas, métrica e log de
  alerta.
- **Outbox lag** = `now() − min(occurred_at)` das linhas não publicadas.

### Eventos de integração

Envelope do §11, `version` 1, valores em `MoneyProps`. `aggregateId` é o
`transactionId` nos eventos de transação e o `walletId` no `WalletBalanceChanged`; a
outbox guarda `wallet_id` para o `MessageGroupId`. O `correlationId` vem de
`wager_transactions.correlation_id`, gravado na primeira inserção — é o que permite
ao worker, minutos depois, emitir a pendente resolvida com o contexto original;
`causationId` = `transactionId`.

| Evento | `data`, além de `transactionId`, `providerId`, `externalTransactionId`, `walletId`, `playerId`, `roundId`, `gameId`, `kind`, `money` e `referenceExternalTransactionId` (quando houver) |
|---|---|
| `WagerTransactionProcessed` | `referenceTransactionId` (se houver), `balanceAfter`, `walletVersion`, `processedAt` |
| `WagerTransactionRejected` | `failureCode`, `balanceAfter`, `walletVersion`, `rejectedAt` |
| `WagerTransactionPendingReference` | `expiresAt` (criação + TTL) |
| `WalletBalanceChanged` | o `data` do §11 (só `walletId`, `transactionId`, `direction`, `money`, `balanceBefore`, `balanceAfter`, `walletVersion`) |

O `WalletBalanceChanged` sai com o `Processed` só quando o saldo muda; a `LOSS`
emite só o `Processed`. `FAILED` não emite evento: não está nos mínimos e é falha
nossa, não fato de negócio — o sinal é o log de alerta e a métrica. A rejeição de
uma pendente (TTL ou referência inválida) emite `Rejected`.

## Referências fora de ordem

Só o worker resolve uma transação `PENDING_REFERENCE`, reivindicada por lease (ver
[Concorrência](#concorrência)); a chegada da referência não a resolve na hora.
Resolver na hora seria seguro, mas é escopo extra — fica como melhoria possível, e a
latência da pendente é limitada pelo intervalo do worker.

- **TTL de 5 minutos** desde a criação, configurável. O que importa ao provedor é
  quanto tempo esperar, não quantas tentativas — que dependem do intervalo interno.
  A desordem real dura segundos; 5 minutos é folga ampla. Esgotado →
  `REJECTED` (`REFERENCE_NOT_FOUND`) e `WagerTransactionRejected`.
- **Backoff:** `next_attempt_at = now + min(1 s × 2^attempts, 60 s)`, jitter de
  ±20%; polling a cada 1 s; lease de 30 s.
- **Casos de borda** (na chegada e a cada tentativa): referência inexistente ou ela
  mesma aguardando referência → espera; referência `REJECTED`/`FAILED` →
  `REFERENCE_NOT_PROCESSED` na hora; outro jogador, carteira, moeda, rodada ou tipo
  errado → rejeição com o código específico, na hora; já desfeita →
  `REFERENCE_ALREADY_REVERSED`.
- **A referência é procurada antes do TTL:** se chegou, a pendente é resolvida
  mesmo com o TTL vencido — uma referência que chegou durante uma queda do banco não
  é rejeitada injustamente. Só referência ausente com TTL vencido dá
  `REFERENCE_NOT_FOUND`.
- **Erros:** transitório reagenda com o mesmo backoff e conta nos retries do
  worker, sem limite de tentativas — o TTL já limita a vida da pendente; permanente
  grava `FAILED` (`INFRA_INVARIANT_VIOLATION` ou `INFRA_UNEXPECTED`) numa segunda
  unidade de trabalho, com alerta. O desfecho é gravado na transação SQL que trava a
  carteira, e o item é relido sob lock: se outro worker já o resolveu, sai sem
  efeito.

## Autenticação

Fora do escopo implementado, como o §2 do enunciado permite: guard no-op atrás de
uma porta de identidade do provedor. *A definir* — o desenho que seria adotado com
Keycloak.

## Observabilidade

- **Logs:** JSON pelo pino, atrás de um adaptador do `LoggerService` do Nest.
  Contexto por `AsyncLocalStorage`: `correlationId`, `messageId`, `transactionId`,
  `walletId`, `providerId`. O `correlationId` vem do header `X-Correlation-Id` (ou é
  gerado) no HTTP e do atributo `correlationId` (ou do `messageId`) na fila, e segue
  até os eventos, com `causationId` = `transactionId`. Só identificadores, `kind`,
  `status` e `failureCode` — nunca valores nem payload; `redact` do pino como rede.
- **Métricas:** prom-client em `GET /metrics`, aberto: transações por
  `kind`/`status`/canal, replays, conflitos de idempotência, duplicatas do inbox,
  retries por componente, DLQ por motivo (envios da aplicação) e profundidade da DLQ
  (`ApproximateNumberOfMessages` no scrape, que cobre o redrive), conflitos de lock
  (`lock_timeout`, deadlock), `outbox_lag_seconds` e `outbox_pending` (lidos do
  banco), latência por canal e tipo, divergências de reconciliação e submissões não
  admitidas por código.
- **Health:** `/health/live` responde enquanto o processo vive; `/health/ready`
  checa `SELECT 1` e `GetQueueAttributes`, com timeout de 1 s cada.

## Testes

- `test:unit` (sem I/O), `test:integration` (app em processo contra PostgreSQL e
  LocalStack reais) e `test:concurrency` (os 8 cenários do §13); `test` = unit +
  integration.
- Isolamento sem limpeza: banco de teste recriado por execução, ids próprios por
  teste, filas com sufixo aleatório.
- ≥ 3 instâncias são processos reais (`Bun.spawn`); no Compose, `--scale app=3`,
  documentado no `README.md`. Crashes no ponto exato (depois
  do commit e antes do `ack`; entre o envio e o `published_at`) vêm de uma porta
  `FaultInjector`, no-op por padrão e ativada só por variável de ambiente nos
  testes.
- Todo teste de integração e de concorrência termina verificando que o saldo é igual
  ao saldo reconstruído e que a sequência de versões não tem buracos.
- Sem `sleep` fixo: espera por condição com timeout.

## Evolução possível

- **Processamento assíncrono da submissão** — ver [Visão geral](#visão-geral).
- **Partidas dobradas:** cada transação geraria também o lançamento de
  contrapartida numa conta da casa ou do provedor; mudaria o livro-razão, o trigger
  saldo ↔ livro-razão e a reconciliação. Fora da entrega por mexer no núcleo
  financeiro perto do prazo.
- **OpenTelemetry:** o contexto já carregado por `AsyncLocalStorage` seria a base
  dos spans; pede coletor e visualizador no Compose.
- **Resolver a pendente na chegada da referência**, reconciliação agendada e
  expurgo das linhas publicadas da outbox.

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
- Eventos de uma mesma carteira podem ser publicados fora de ordem por publicadores
  concorrentes; o consumidor ordena por `walletVersion`/`occurredAt`.
- Eventos são publicados pelo menos uma vez; duplicatas carregam o mesmo `eventId`.
- Linhas publicadas da outbox não são expurgadas.
- A chave de idempotência da criação de carteira é global, não por provedor: a
  carteira não tem provedor e a autenticação está fora do escopo.
- Saldo acumulado além de `numeric(19,2)` vira `FAILED`
  (`INFRA_INVARIANT_VIOLATION`), não rejeição — inalcançável com o teto de entrada.
