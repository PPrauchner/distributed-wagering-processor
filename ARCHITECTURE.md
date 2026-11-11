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

Fora dos módulos fica, de propósito, a **raiz de composição**: o código que conhece
todos os módulos para montá-los, e que por isso não cabe em nenhum deles.

- `main.ts`, `app.ts` e `config.ts` — entrada, montagem do app NestJS e leitura do
  ambiente;
- `database/` — configuração do MikroORM com as entidades e migrations de cada
  módulo registradas explicitamente, a implementação da `UnitOfWork` que entrega os
  repositórios de cada módulo, o runner de migrations, o classificador único dos
  erros do banco e a tradução deles para os erros de cada módulo, e o
  `FaultInjector` ligado à transação SQL;
- `http/` — o filtro de erros, que traduz os erros de todos os módulos nas
  respostas HTTP e reporta as submissões não admitidas à auditoria.

Colocá-los em `shared/` faria `shared` depender de `wallet` (e, depois, de
`wagering` e `messaging`), invertendo a direção da dependência: `shared` é a base
que os módulos importam, nunca o contrário. A raiz de composição pode importar
qualquer módulo; nenhum módulo a importa.

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
cada unidade de trabalho que toca a carteira — move saldo ou insere uma linha com FK
para ela; uma carteira por transação, sem lock
global. `lock_timeout` de 2 s, por `SET LOCAL` logo antes do `SELECT … FOR UPDATE`
— vale para a transação SQL que trava a carteira, nunca para a conexão, e cobre
toda espera de lock depois dela: estourar é erro transitório
(`TRANSIENT_LOCK_TIMEOUT`) e conta como conflito de lock. `version` é contador
monotônico, não lock otimista.

Não há deadlock por uma regra de ordem: **o lock da carteira é o primeiro lock de
toda transação SQL que toca uma carteira**. Por isso os workers (referências
pendentes e publicador da outbox) reivindicam itens com um **lease** numa transação
SQL curta e separada (`FOR UPDATE SKIP LOCKED` + `next_attempt_at = now() + lease`,
com commit). O worker de referências pendentes processa cada item numa unidade de
trabalho própria, que começa pela carteira; **o publicador da outbox não trava a
carteira** — nenhuma das suas transações SQL toca `wallets` (emenda do ADR 0002).
A gravação de `FAILED` do use case (segunda unidade de trabalho, depois do rollback
de um erro permanente) insere a transação de aposta, cuja FK `wallet_id` toma
`FOR KEY SHARE` na carteira: por isso começa pelo lock da carteira, com o mesmo
`lock_timeout`, antes de qualquer outra escrita — a regra vale sem exceção (emenda
do ADR 0002). A gravação de `FAILED` do worker de referências pendentes é um
`UPDATE` que não muda a FK e não toca `wallets`.
Worker morto: o lease expira e outra instância assume. Ver
[ADR 0002](docs/adr/0002-lock-pessimista-por-carteira.md).

## Invariantes no schema

| Tabela | Garantias |
|---|---|
| `wallets` | `CHECK (balance_amount >= 0)`, `CHECK (version >= 1)`, `CHECK (currency = balance_currency)`; `UNIQUE (player_id, currency)`; `UNIQUE (id, currency)` (alvo da FK de moeda); `UNIQUE (creation_idempotency_key)` (anulável) e `CHECK` de chave e hash da criação ambos nulos ou ambos preenchidos; `initial_balance` |
| `wager_transactions` | `UNIQUE (provider_id, idempotency_key)`; `UNIQUE (provider_id, external_transaction_id)`; FK `wallet_id NOT NULL`; FK `reference_transaction_id` na própria tabela; índice único parcial da reversão; `CHECK`s de coerência (`REFUND`/`ROLLBACK` ⇒ referência externa preenchida, `BET`/`LOSS`/`OPENING` ⇒ nula, `WIN` livre; `PENDING_REFERENCE` só para `REFUND`, `ROLLBACK` e `WIN`; `PROCESSED` ⇔ `processed_at`; `REJECTED`/`FAILED` ⇔ `failure_code`; `failure_message` só com `failure_code`; `PROCESSED`/`REJECTED` ⇔ `balance_after` e `wallet_version_observed` preenchidos; `status <> 'PENDING'`); `amount > 0`, exceto `LOSS` (`>= 0`); `correlation_id NOT NULL`; índice parcial `WHERE status = 'PENDING_REFERENCE'` |
| `wallet_ledger_entries` | `UNIQUE (transaction_id, wallet_id)`; `UNIQUE (wallet_id, wallet_version)`; FK composta e `CHECK` de moeda; `amount > 0`; `CHECK` da aritmética (`balance_after = balance_before ± amount` pela `direction`, saldos `>= 0`) |
| `inbox_messages` | PK `(consumer_name, message_id)` |
| `outbox_messages` | `wallet_id NOT NULL` (o `MessageGroupId`); índice parcial `WHERE published_at IS NULL` em `next_attempt_at`; `CHECK (attempts >= 0)`; sem FK |
| `rejected_submissions` | append-only, sem FK nem unicidade (a PK é um UUID substituto); só `failure_code`, `channel` (`HTTP` ou `QUEUE`, por `CHECK`) e `received_at` obrigatórios — `correlation_id` e o resto anuláveis |

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
- **Auditoria append-only:** `UPDATE`, `DELETE` e `TRUNCATE` em
  `rejected_submissions` são recusados.

**Saldo máximo:** `99999999999999999.99`, o limite de `numeric(19,2)`. Não há
`CHECK` próprio: o tipo da coluna já recusa o valor acima dele (`22003`) antes de
qualquer `CHECK`, que por isso nunca dispararia — o próprio tipo é a garantia no
schema. O domínio barra antes (`Wallet.canCredit`): `WIN`, `REFUND` e `ROLLBACK`
de `BET` que passariam do máximo terminam `REJECTED` `BALANCE_LIMIT_EXCEEDED`,
sem lançamento, com o saldo observado e `WagerTransactionRejected`; o `22003`
fica só como rede de segurança. A `OPENING` não alcança o máximo: o
`initialBalance` passa pelo teto de 15 dígitos da entrada. A reconciliação lê os
valores do banco por `Money.fromPersisted`, sem esse teto, e reporta saldos de
16 e 17 dígitos normalmente.

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
  1, `idempotentReplay: true`), mesmo que a carteira já tenha movimentado; hash
  diferente → 409 `IDEMPOTENCY_CONFLICT`, avaliado antes da existência da carteira.
  Header presente e vazio → 400 `MISSING_IDEMPOTENCY_KEY`, como na submissão. Na
  corrida de duas criações com a mesma chave, qualquer violação de unicidade relê
  pela chave e compara o hash: uma resposta cria e as outras são replay. Sem o
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
  lançamentos, contagem, buracos na sequência e maior versão lançada. A resposta
  do §9 ganha `versionGaps`, `walletVersion` e `lastEntryVersion`. Divergência de
  valor, buraco ou lançamento acima da versão da carteira → `consistent: false`, log `error`
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
   referência obrigatória ausente ou proibida presente, referência ao próprio
   `externalTransactionId`) → `INVALID_PAYLOAD`;
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
   divergente na ordem jogador, carteira, moeda, rodada — o provedor não diverge:
   a referência é buscada pelo provedor da própria submissão;
   `REFERENCE_AMOUNT_MISMATCH`, exceto no `WIN`; `REFERENCE_ALREADY_REVERSED`, só na
   transação dependente); saldo (`INSUFFICIENT_FUNDS` ou
   `REVERSAL_INSUFFICIENT_FUNDS` no débito; `BALANCE_LIMIT_EXCEEDED` no crédito
   que passaria do saldo máximo — sempre depois da referência, então uma
   referência ausente espera e nunca vira `BALANCE_LIMIT_EXCEEDED`).

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
replay. O hash é calculado sobre o comando já validado, com o `walletId`
normalizado em minúsculas (UUID não diferencia caixa); campo desconhecido no corpo
é 400, para que dois payloads diferentes nunca compartilhem hash. Uma única função,
comum às duas entradas.

### Submissões não admitidas

Toda submissão que **não vira transação de aposta** é gravada numa tabela própria,
append-only e sem FK: payload inválido (HTTP ou fila), carteira inexistente,
`OPENING` vindo de fora, conflito de idempotência, `EXTERNAL_ID_CONFLICT`,
`PROVIDER_IDENTITY_MISMATCH` (só HTTP) e, na fila, `MESSAGE_ID_CONFLICT` e as tentativas transitórias esgotadas
(`INFRA_RETRIES_EXHAUSTED`). Colunas: `provider_id`, `idempotency_key`,
`external_transaction_id`, `payload_hash`, código de falha, canal, `message_id`
(quando houver), `correlation_id` e `received_at` — o que der para
extrair, já que um payload inválido pode não ter chave. O insert roda numa unidade
de trabalho própria, no ponto em que a submissão deixa de ser admitida; sem unicidade (cada tentativa é uma linha).
Replays não entram: são métrica.

**No HTTP, esse ponto é o filtro global de erros:** é o único por onde passa toda
submissão não admitida — o JSON malformado nem chega ao controller. Antes de
responder, ele a reporta à auditoria do endpoint de submissão
(`RejectedSubmissionAudit`), que grava só as submissões não admitidas de
`POST /wagering/transactions`: `provider_id` e `external_transaction_id` do corpo,
quando é um objeto e os traz como texto; `idempotency_key` e `correlation_id` dos
headers; `payload_hash` quando a não admissão veio depois do hash (`OPENING`, conflitos,
carteira inexistente). A resposta não muda. A auditoria é de melhor esforço: se o
insert falhar, o erro é logado e a resposta sai igual. As submissões não admitidas
da criação de carteira e das consultas não entram.

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
| provedor declarado diferente da identidade (`PROVIDER_IDENTITY_MISMATCH`) | 403 |
| recurso inexistente num `GET` | 404 |
| conflito de idempotência, `EXTERNAL_ID_CONFLICT`, `WALLET_ALREADY_EXISTS` | 409 |
| `REJECTED` (original ou replay), `WALLET_NOT_FOUND` | 422 |
| `FAILED` / erro permanente | 500 |
| falha transitória (lock, deadlock, banco ou SQS fora) | 503 + `Retry-After` |

Desfechos de transação respondem com o resultado da transação (`transactionId`,
`status`, `failureCode`, saldo, `idempotentReplay` e, quando o código sozinho não
basta, `message` — o campo divergente do `REFERENCE_MISMATCH`, gravado em
`wager_transactions.failure_message` para o replay devolvê-lo igual); erros sem transação respondem
`{ failureCode, message }` — o 409 `WALLET_ALREADY_EXISTS` acrescenta o `walletId`.
O `GET` de transação devolve o mesmo corpo do desfecho, mais os campos de
identidade, sem `idempotentReplay`. O 503 leva `Retry-After: 1` (segundos,
configurável por `RETRY_AFTER_SECONDS`). Um erro permanente fora de uma transação
de aposta (na criação de carteira, por exemplo) responde 500 com o código
(`INFRA_INVARIANT_VIOLATION` ou `INFRA_UNEXPECTED`), sem `transactionId`; um erro
que nem vem do banco é `INFRA_UNEXPECTED`.

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
| `REFERENCE_MISMATCH` | rejeição (422) | corrige; jogador, carteira, moeda ou rodada divergem (campo no `message`) |
| `REFERENCE_AMOUNT_MISMATCH` | rejeição (422) | corrige o valor; reversão parcial não existe |
| `REFERENCE_ALREADY_REVERSED` | rejeição (422) | desiste; a referência já foi desfeita |
| `BALANCE_LIMIT_EXCEEDED` | rejeição (422) | desiste; o crédito passaria do saldo máximo (`99999999999999999.99`) |
| `INVALID_PAYLOAD` | não admitida (400) | corrige o payload |
| `MISSING_IDEMPOTENCY_KEY` | não admitida (400) | envia o header |
| `INTERNAL_KIND_NOT_ALLOWED` | não admitida (400) | não envia `OPENING` |
| `INVALID_CURSOR` | não admitida (400) | usa o cursor devolvido pela API |
| `IDEMPOTENCY_CONFLICT` | não admitida (409) | usa uma chave nova para um payload novo |
| `EXTERNAL_ID_CONFLICT` | não admitida (409) | o id externo já tem outra chave; corrige |
| `WALLET_ALREADY_EXISTS` | não admitida (409) | usa a carteira existente |
| `WALLET_NOT_FOUND` | não admitida (422; fila: retry, depois DLQ) | cria a carteira e reenvia |
| `MESSAGE_ID_CONFLICT` | não admitida (fila → DLQ) | não reusa `messageId` com outro conteúdo |
| `PROVIDER_IDENTITY_MISMATCH` | não admitida (403; só HTTP) | declara o próprio `providerId` |
| `NOT_FOUND` | consulta (404) | — |
| `INFRA_RETRIES_EXHAUSTED` | sem desfecho (fila → DLQ) | reenvia **com a mesma chave** depois de normalizado (redrive da DLQ ou HTTP) |
| `INFRA_INVARIANT_VIOLATION` | falha (500, alerta) | bug nosso; reenvia com chave nova depois da correção |
| `INFRA_UNEXPECTED` | falha (500) | idem |
| `TRANSIENT_LOCK_TIMEOUT` | transitório (503) | reenvia com a mesma chave após `Retry-After` |
| `TRANSIENT_UNAVAILABLE` | transitório (503) | idem |

## Classificação de falhas

Erros do banco passam por um classificador único (`database/`), por SQLSTATE e
nome da constraint; a unidade de trabalho traduz só os erros que vêm do banco ou da
conexão (os que trazem um SQLSTATE ou um código de rede), e os da aplicação passam
intactos. `REJECTED` vem só do domínio, nunca do classificador. Ver
[ADR 0001](docs/adr/0001-mikroorm-7-com-invariantes-no-schema.md).

| Erro | Categoria |
|---|---|
| `55P03` (`lock_timeout`; o MikroORM não o mapeia, é reconhecido pelo código), `40P01`, `40001` | transitório → 503 `TRANSIENT_LOCK_TIMEOUT` |
| queda ou recusa de conexão (`ECONNREFUSED` e afins, classe `08`, `53300`, `57P01`–`57P03`) | transitório → 503 `TRANSIENT_UNAVAILABLE` |
| `23505` | pela constraint, tabela abaixo |
| `23514` (`CHECK`), `23503` (FK de moeda), `23502`, `23000` (os triggers do schema) e `22003` | permanente → `FAILED`, `INFRA_INVARIANT_VIOLATION` |
| qualquer outro | permanente → `FAILED`, `INFRA_UNEXPECTED` |

Unicidade violada (`23505`): se a disputa escapa do lock da carteira, é desfecho
legítimo; se o lock a serializa, o domínio teria visto antes, e é bug.

| Constraint | Categoria |
|---|---|
| `wallets (player_id, currency)` — `wallets_player_currency_unique` | conflito → 409 `WALLET_ALREADY_EXISTS`, com `walletId` |
| `wallets (creation_idempotency_key)` — `wallets_creation_idempotency_key_unique` | relê e compara o hash → replay ou conflito |
| `(provider_id, idempotency_key)` — `wager_transactions_provider_idempotency_key_unique` | relê e compara o hash → replay ou conflito |
| `(provider_id, external_transaction_id)` — `wager_transactions_provider_external_id_unique` | conflito → `EXTERNAL_ID_CONFLICT` |
| `inbox (consumer_name, message_id)` — `inbox_messages_pkey` | redelivery → `ack` sem efeito (de um `FAILED`: DLQ de novo, depois `ack`) |
| reversão única por referência — `wager_transactions_single_reversal_unique` | bug → permanente (`FAILED`, alerta) |
| lançamento `(transaction_id, wallet_id)` — `wallet_ledger_entries_transaction_wallet_unique` | bug → permanente (`FAILED`, alerta) |
| lançamento `(wallet_id, wallet_version)` — `wallet_ledger_entries_wallet_version_unique` | bug → permanente (`FAILED`, alerta) |
| outra | permanente (`FAILED`, `INFRA_UNEXPECTED`) |

Estouro numérico (`22003`) também é permanente (`INFRA_INVARIANT_VIOLATION`,
alerta), mas é só rede de segurança: o saldo acumulado além de `numeric(19,2)` é
alcançável somando créditos, e o domínio o barra antes, como rejeição
`BALANCE_LIMIT_EXCEEDED` (ver [Invariantes no schema](#invariantes-no-schema)).
Disparar o `22003` é bug.

**Quem grava `FAILED`: o use case**, nas duas entradas. Como a transação SQL do
erro permanente já sofreu rollback, uma **segunda unidade de trabalho** grava a
transação de aposta como `FAILED`, com o código de falha (e o inbox, quando a
entrada é a fila), pela chave de idempotência, começando pelo lock da carteira (ver
[Concorrência](#concorrência)) — sem saldo observado, sem lançamento
e sem evento. No HTTP, a resposta é 500 com `transactionId`, `status: FAILED` e
`failureCode`, e o replay (mesma chave e hash) devolve o mesmo 500 com
`idempotentReplay: true`; hash diferente → 409 `IDEMPOTENCY_CONFLICT`. A segunda
unidade de trabalho relê a chave antes de gravar: se um concorrente já a gravou, ou
se ela cai no `23505` da chave, responde como replay ou conflito; se falha de forma
transitória, 503 sem gravar nada. Na fila, a
mensagem é enviada explicitamente à DLQ e apagada da fila principal (se a remoção
falhar, a redelivery é reconhecida pelo inbox). Só o erro permanente grava `FAILED`:
a falha transitória nunca vira `FAILED`, nem esgotada.

- **Transitório na fila:** sem `ack`; backoff por `ChangeMessageVisibility`
  (`min(2^receiveCount s, 60 s)`). Esgotados **5 recebimentos**, a mensagem termina
  **sem desfecho**: vai à DLQ com `failureCode` `INFRA_RETRIES_EXHAUSTED`, com linha
  em `rejected_submissions` e sem transação de aposta nem inbox — o mesmo caminho da
  carteira inexistente. A chave fica livre: reprocessar a mensagem da DLQ, ou
  reenviá-la por HTTP com a mesma chave, aplica a transação normalmente. O
  `maxReceiveCount` do redrive é **6**: rede de segurança para o banco fora do ar.
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
- `ack` (`DeleteMessage`) só depois do commit. A mensagem que vem pela fila passa
  pelo mesmo use case da API, que grava o inbox na unidade de trabalho do
  desfecho — também num replay, quando a mesma transação já veio por HTTP. A
  redelivery é recusada pela PK do inbox no commit (`InboxRedeliveryError`):
  `ack` sem efeito e `inbox_duplicates_total` incrementada — salvo quando a
  transação da chave está `FAILED` (`FailedRedeliveryError`, com o código): o
  envio à DLQ pode ter sido o que falhou, então a mensagem vai à DLQ de novo
  antes do `ack`. O mesmo `messageId`
  com hash diferente também esbarra na PK: o use case relê a linha do inbox,
  compara o hash e responde `MessageIdConflictError`.
- **Desfecho de cada mensagem:** `PROCESSED`, `REJECTED` ou `PENDING_REFERENCE` →
  `ack`. Transitório (`TRANSIENT_LOCK_TIMEOUT`, `TRANSIENT_UNAVAILABLE`) e
  `WALLET_NOT_FOUND` → sem `ack`, `ChangeMessageVisibility` de
  `min(2^ApproximateReceiveCount s, 60 s)`. No 5º recebimento, os dois terminam sem
  desfecho, como submissão não admitida: DLQ com `INFRA_RETRIES_EXHAUSTED` ou
  `WALLET_NOT_FOUND`, linha em `rejected_submissions` (canal fila, `payload_hash`
  da mensagem), `ack` — sem transação de aposta nem inbox, então a chave fica livre
  para o redrive da DLQ ou um reenvio por HTTP. Se o envio à DLQ ou a gravação da
  recusa falhar (banco fora), a mensagem fica para o redrive nativo
  (`maxReceiveCount` 6) e chega à DLQ sem o atributo `failureCode` e sem linha de
  auditoria — limitação aceita. `FAILED` (erro permanente, ou o replay de um)
  → DLQ com o código do classificador. Submissão não admitida → DLQ direto.
- **Envio à DLQ:** feito pela aplicação (`SendMessage` em
  `wager-transactions-dlq.fifo`, porta `DeadLetterQueue`), com o corpo e os
  atributos originais mais o atributo `failureCode`; `MessageGroupId` = `walletId`
  (ou `unroutable`), `MessageDeduplicationId` = `MessageId` do SQS da mensagem
  recebida — não o `messageId` do envelope: a reentrega da mesma mensagem tem o
  mesmo id e é absorvida, mas o mesmo corpo reenviado à fila (o redrive da DLQ) é
  outra mensagem, e se esgotar de novo dentro da janela de 5 min do FIFO precisa
  chegar à DLQ de novo, em vez de ser descartado pela deduplicação. `walletId`
  extraído que o SQS não aceita como id (mais de 128 caracteres, ou fora de ASCII
  alfanumérico e pontuação) conta como ausente. Dos atributos originais vão até 9, `correlationId` primeiro: o SQS
  aceita 10 por mensagem, contando o `failureCode`. Ordem: DLQ, linha em
  `rejected_submissions` (só nas não admitidas, com canal fila, `message_id` e
  `correlation_id`), `ack`. Se qualquer passo falha, a mensagem fica e é
  decidida de novo na reentrega — pelo inbox, quando já há desfecho; o
  `MessageDeduplicationId` absorve o reenvio à DLQ da mesma mensagem dentro de
  5 min.
- O contexto de log de cada mensagem abre com o `messageId` do envelope e o
  `correlationId` (atributo da mensagem, ou o `messageId`).
- **Configuração por ambiente:** `WAGER_TRANSACTIONS_CONSUMER_ENABLED` (padrão
  `true`), `WAGER_TRANSACTIONS_WAIT_SECONDS` (20, de 0 a 20),
  `WAGER_TRANSACTIONS_BATCH_SIZE` (10, de 1 a 10),
  `WAGER_TRANSACTIONS_VISIBILITY_SECONDS` (30), `WAGER_TRANSACTIONS_MAX_RECEIVES`
  (5), `WAGER_TRANSACTIONS_RETRY_MAX_SECONDS` (60, o teto do backoff),
  `WAGER_TRANSACTIONS_DRAIN_TIMEOUT_MS` (20000), `WAGER_TRANSACTIONS_QUEUE` e
  `WAGER_TRANSACTIONS_DLQ` (`wager-transactions-dlq.fifo`).
- **`SIGTERM`:** pelo `beforeApplicationShutdown` de cada um, o consumidor
  interrompe o long polling (`AbortSignal`) e os workers param de reivindicar;
  o consumidor espera as mensagens em andamento por até 20 s
  (`stop_grace_period` de 30 s no Compose) e devolve com visibilidade 0 as que
  chegaram já no desligamento, sem iniciá-las; depois o Nest fecha HTTP e pool.
  Se o prazo estourar, a transação SQL é atômica e a redelivery é segura; leases
  expiram. Um long polling interrompido depois de o SQS responder deixa suas
  mensagens invisíveis até a visibilidade expirar.

### Publicador da outbox

- **Destino:** `wagering-events.fifo`; `MessageGroupId` = `walletId`,
  `MessageDeduplicationId` = `eventId` (otimização do broker, não garantia).
- **Publicado** = `SendMessageBatch` com sucesso para o item; `published_at` é
  gravado numa transação SQL curta. Se a instância morre entre o envio e a gravação,
  o lease expira e outra reenvia: **at-least-once**, e o consumidor deduplica pelo
  `eventId`, estável desde o `enqueue`.
- **Contrato com o consumidor dos eventos:** o mesmo evento pode chegar mais de
  uma vez, sempre com o mesmo `eventId` e o mesmo corpo; o consumidor **deduplica
  por `eventId`**. O `MessageDeduplicationId` do FIFO só cobre reenvios dentro da
  janela de 5 min do SQS — fora dela, a duplicata chega. O teste de integração do
  publicador prova o reenvio idêntico: dois publicadores com lease expirado
  publicam o mesmo item, e um cliente SQS real que registra os envios (sem mock)
  mostra o mesmo `eventId` e o mesmo corpo nas duas publicações.
- Polling a cada 500 ms, lotes de até 10, lease de 30 s. Falha → `scheduleRetry`
  com `min(1 s × 2^attempts, 5 min)` e jitter. **Sem limite de tentativas** —
  desistir perderia evento confirmado; a partir de 10 tentativas, métrica e log de
  alerta. Um lote cheio dispara o ciclo seguinte na hora, sem esperar o polling.
- **Três passos, duas transações SQL curtas, nenhuma na carteira:** reivindicação
  (`PublishOutbox`, um único `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED
  LIMIT 10) RETURNING id`), envio fora de transação, e gravação do desfecho de cada
  item (`published_at` ou `scheduleRetry`). Um lote que nem chega ao SQS (fila
  inexistente, SQS fora) reagenda todos os itens. Todo envio que falha gera um log
  `warn` com o motivo — o erro do lote inteiro, ou o `Code`/`Message` de cada item
  recusado —, para que uma fila mal configurada não fique invisível.
- **Parada:** em `beforeApplicationShutdown` o publicador para de reivindicar e
  espera o ciclo em andamento, antes dos ganchos de `onApplicationShutdown` que
  fecham o ORM e o cliente SQS.
- **Configuração por ambiente:** `OUTBOX_PUBLISHER_ENABLED` (padrão `true`),
  `OUTBOX_POLL_INTERVAL_MS` (500), `OUTBOX_LEASE_MS` (30000),
  `OUTBOX_RETRY_BASE_MS` (1000), `OUTBOX_RETRY_MAX_MS` (300000),
  `WAGERING_EVENTS_QUEUE` (`wagering-events.fifo`), `WAGER_TRANSACTIONS_QUEUE`
  (`wager-transactions.fifo`, consultada pela prontidão), `SQS_ENDPOINT`
  (`http://127.0.0.1:4566`), `AWS_REGION` e credenciais (padrões do LocalStack).
- **Filas na subida:** o Compose monta `localstack/init/ready.d/create-queues.sh`
  no LocalStack, que cria `wager-transactions.fifo`, `wager-transactions-dlq.fifo`
  (redrive com `maxReceiveCount` 6) e `wagering-events.fifo` (sem DLQ); o
  healthcheck só passa com as filas criadas, e o app espera por ele.
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
- **Agendamento:** `attempts` e `next_attempt_at` em `wager_transactions`; a
  chegada grava `attempts = 0` e `next_attempt_at` pelo backoff, com o
  `WagerTransactionPendingReference` na mesma transação SQL. A reivindicação é um
  único `UPDATE … FROM (SELECT … FOR UPDATE SKIP LOCKED LIMIT 10)` que empurra
  `next_attempt_at` para `now() + lease`; um lote cheio dispara o ciclo seguinte
  na hora. Pendente que continua esperando conta a tentativa e reagenda, sem mudar
  de estado.
- **Parada:** em `beforeApplicationShutdown` o worker para de reivindicar, deixa
  os itens do lote ainda não iniciados (seguem com lease, que expira) e espera o
  item em processamento, antes de o ORM fechar. É o ponto que o desligamento geral
  (`SIGTERM`) chama.
- **Configuração por ambiente:** `PENDING_REFERENCES_WORKER_ENABLED` (padrão
  `true`), `PENDING_REFERENCE_TTL_MS` (300000), `PENDING_REFERENCES_POLL_INTERVAL_MS`
  (1000), `PENDING_REFERENCES_LEASE_MS` (30000), `PENDING_REFERENCES_RETRY_BASE_MS`
  (1000) e `PENDING_REFERENCES_RETRY_MAX_MS` (60000).

## Autenticação

Fora do escopo implementado, como o §2 do enunciado permite: guard no-op atrás de
uma porta de identidade do provedor. O ponto de extensão no código:

- **Porta** `ProviderIdentity` (`src/shared/application/provider-identity.ts`):
  resolve, a partir da requisição, o provedor autenticado. Ligada pelo token
  `PROVIDER_IDENTITY` num módulo global da raiz de composição (`src/app.ts`);
  trocar pela implementação real é trocar esse provider do Nest.
- **No-op** `DeclaredProviderIdentity`
  (`src/shared/infrastructure/declared-provider-identity.ts`): autentica a
  requisição como o provedor que ela declara — nunca diverge.
- **Guard** `ProviderIdentityGuard` (`src/shared/interface/provider-identity.guard.ts`),
  nos controllers de transação de aposta e de carteira: chama a porta e deixa a
  identidade para o controller (`@CurrentProvider()`). `/health/*` e `/metrics`
  ficam sem guard; a fila também — é canal interno confiável.
- **Conferência:** na submissão (depois do parse do corpo, antes do use case) e na
  consulta por id externo, um `providerId` diferente da identidade é recusado com
  403 `PROVIDER_IDENTITY_MISMATCH`, sem transação de aposta; na submissão, a recusa
  é auditada como submissão não admitida. `MISSING_IDEMPOTENCY_KEY` e o
  `INVALID_PAYLOAD` de forma vêm antes. As rotas de carteira e a consulta por id
  interno não declaram provedor: o guard só resolve a identidade.

*A definir* — o desenho que seria adotado com Keycloak.

## Observabilidade

- **Logs:** JSON pelo pino, atrás de um adaptador do `LoggerService` do Nest e da
  porta `ContextLog` dos use cases (`shared`). Contexto por `AsyncLocalStorage`:
  `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`, misturados
  em toda linha emitida dentro dele. O HTTP abre o contexto por requisição com o
  `X-Correlation-Id`, quando há; sem ele, o use case acrescenta o id que gera — o
  mesmo gravado na transação, uma fonte só. Na fila, o `correlationId` vem do
  atributo `correlationId` (ou do `messageId`), e segue até os eventos, com
  `causationId` = `transactionId`. Só identificadores, `kind`, `status` e
  `failureCode` — nunca valores nem payload; o `redact` do pino (dinheiro, saldos,
  corpos) é a rede.
- **Métricas:** prom-client em `GET /metrics`, aberto, num registro próprio por
  aplicação (os testes sobem várias num processo). Todas existem desde a partida:
  - `wager_transactions_total{kind,status,channel}` — transações novas;
  - `wager_transaction_idempotent_replays_total{channel}`;
  - `wager_transaction_idempotency_conflicts_total{channel}`;
  - `rejected_submissions_total{failure_code,channel}` — submissões não admitidas;
  - `inbox_duplicates_total` — registrada em zero, incrementada pelo consumidor;
  - `lock_conflicts_total{reason}` — `lock_timeout`, `deadlock` ou
    `serialization_failure`, que o classificador distingue pelo SQLSTATE;
  - `outbox_pending` e `outbox_lag_seconds` (`now() − min(occurred_at)` das não
    publicadas), lidos do banco numa única leitura por scrape, compartilhada
    pelos dois gauges, com limite de 1 s — se a leitura
    falha ou estoura o prazo, os gauges ficam no último valor lido e a falha vai
    para o log, e o resto do `/metrics` continua sendo coletado;
  - `wager_transaction_processing_seconds{channel,kind}` — histograma da latência
    das submissões que terminaram numa transação;
  - `reconciliation_divergences_total`.

  - `wager_transactions_consumer_retries_total{failure_code}` — entregas da fila
    de entrada devolvidas para retry;
  - `wager_transactions_dlq_messages_total{failure_code}` — envios à DLQ feitos
    pela aplicação.

  A profundidade da DLQ (`ApproximateNumberOfMessages` no scrape, que cobriria o
  redrive) ainda não entra.
- **Health:** `/health/live` responde 200 enquanto o processo vive, sem tocar no
  banco nem na fila; `/health/ready` roda `SELECT 1` e `GetQueueAttributes` nas
  filas de entrada e de eventos, cada um com timeout de 1 s, e responde 200 ou 503
  com o estado de cada sonda. As sondas de fila têm um cliente SQS próprio, sem
  retry, para falhar dentro do prazo. Nenhum dos dois é autenticado.

## Testes

- `test:unit` (sem I/O), `test:integration` (app em processo contra PostgreSQL e
  LocalStack reais) e `test:concurrency` (os 8 cenários do §13); `test` = unit +
  integration.
- Isolamento sem limpeza: banco de teste recriado por execução, ids próprios por
  teste, filas com sufixo aleatório.
- ≥ 3 instâncias são processos reais (`Bun.spawn`); no Compose,
  `APP_PORTS=3000-3002 docker compose up -d --wait --scale app=3` (uma porta do
  host por réplica; sem `APP_PORTS`, uma instância em `:3000`), documentado no
  `README.md`. Falhas no ponto exato vêm da porta `FaultInjector`
  (`shared/application`), oferecida pela unidade de trabalho: no-op por padrão,
  ativada só por `FAULT_INJECTION` (nomes de pontos separados por vírgula; nome
  desconhecido e `NODE_ENV=production` são recusados na partida). Pontos:
  `invariant-violation-before-commit` — dentro da unidade de trabalho, antes do
  commit, altera a transação de aposta terminal recém-gravada, que o trigger
  recusa, para o erro verdadeiro passar pelo classificador —; `crash-after-send` —
  o publicador "morre" entre o envio e o `published_at`: lança
  `SimulatedCrashError` antes de gravar, e a transação SQL da gravação desfaz —;
  `crash-after-commit` — o consumidor morre depois do commit do desfecho e antes
  do `ack`: o app rodando como processo (`main.ts`) leva `SIGKILL` de si mesmo,
  por uma função de queda que a raiz de composição injeta no `CrashFaultInjector`;
  em processo (integração e unidade), lança `SimulatedCrashError`, para não
  derrubar o test runner. A mensagem volta quando a visibilidade expira e o inbox
  a reconhece —;
  e `transient-failure-in-resolution` — o worker de referências pendentes, já com
  o lock da carteira, recebe `lock_not_available` do banco: transitório real, e o
  item é reagendado. O `invariant-violation-before-commit` vale também para a
  resolução de uma pendente, que grava então `FAILED`.
  Os pontos de queda fora de uma unidade de trabalho vêm do `CrashFaultInjector`.
- Os apps dos testes sobem sem publicador da outbox (`OUTBOX_PUBLISHER_ENABLED=false`
  no preload) e sem consumidor da fila de entrada
  (`WAGER_TRANSACTIONS_CONSUMER_ENABLED=false`) nem worker de referências
  pendentes (`PENDING_REFERENCES_WORKER_ENABLED=false`); os testes do publicador e
  do consumidor ligam o seu, com filas próprias, e os das pendentes chamam o ciclo
  do worker direto, com TTL e backoff curtos. Como o banco
  de teste é compartilhado entre os arquivos, um publicador de teste pode entregar
  eventos de outros arquivos: as verificações olham os eventos do próprio teste, e
  "desconhecido" quer dizer fora da outbox.
- Todo teste de integração e de concorrência termina verificando que o saldo é igual
  ao saldo reconstruído e que a sequência de versões não tem buracos.
- Sem `sleep` fixo: espera por condição com timeout, por um helper único
  (`test/support/wait-until.ts`) compartilhado por integração e concorrência.
- Além das checagens por arquivo, um `afterAll` global no preload reconcilia todas
  as carteiras do banco de teste ao fim da execução; as corrompidas de propósito
  saem dessa checagem por `excludeFromLedgerInvariant`.
- O teste do `SIGTERM` sobe o app como processo real (`Bun.spawn` de
  `src/main.ts`). No Windows não há sinal POSIX — `kill('SIGTERM')` encerra o
  processo na hora —, então lá o teste manda `SIGTERM` por IPC e o preload
  `test/integration/support/shutdown-on-ipc.ts` o emite no processo, pelos mesmos
  listeners do `enableShutdownHooks`; nos demais sistemas, sinal de verdade.

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
- **Balanceador HTTP** (nginx) na frente das réplicas do Compose, com uma porta só
  — ver [Limitações conhecidas](#limitações-conhecidas).

## Limitações conhecidas

- `orderBy` pelo nome do getter (`accessor`) falha em runtime no MikroORM 7.2.8;
  ordenação por estado privado fica no repositório.
- O conversor de erros do MikroORM para PostgreSQL não mapeia o estouro de
  `lock_timeout` (`55P03`); ele é reconhecido pelo código.
- A vazão de uma única carteira é limitada pela duração da transação, por causa do
  lock pessimista.
- Esgotadas as tentativas transitórias na fila, a mensagem vai à DLQ sem desfecho
  (`INFRA_RETRIES_EXHAUSTED`): a transação de aposta não existe, e reprocessar a DLQ
  — ou reenviar por HTTP com a mesma chave — aplica a transação. Se, no último
  recebimento, o envio à DLQ ou a gravação da recusa também falhar (PostgreSQL ou
  SQS fora), o redrive nativo do SQS leva a mensagem à DLQ sem o atributo
  `failureCode` e sem linha em `rejected_submissions`; reprocessá-la continua seguro
  pela idempotência.
- `FAILED` é terminal para a chave de idempotência, inclusive quando a causa foi um
  bug: corrigido o bug, o provedor reenvia com uma chave nova. Só erro permanente
  grava `FAILED`; a falha transitória esgotada não.
- Eventos de uma mesma carteira podem ser publicados fora de ordem por publicadores
  concorrentes; o consumidor ordena por `walletVersion`/`occurredAt`.
- Eventos são publicados pelo menos uma vez; duplicatas carregam o mesmo `eventId`
  e o mesmo corpo, e o consumidor deduplica por `eventId`.
- Linhas publicadas da outbox não são expurgadas.
- A chave de idempotência da criação de carteira é global, não por provedor: a
  carteira não tem provedor e a autenticação está fora do escopo.
- O saldo máximo é o limite técnico da coluna (`99999999999999999.99`), não uma
  regra de negócio configurável: o crédito que o passaria — alcançável somando
  créditos no teto de entrada — é rejeitado com `BALANCE_LIMIT_EXCEEDED`, e a
  carteira cheia só volta a receber crédito depois de um débito. Alargá-lo exige
  alargar a coluna.
- No Compose, o HTTP não é balanceado: com `--scale app=3`, cada réplica fica numa
  porta da faixa `APP_PORTS`, e quem chama só `:3000` fala com uma réplica. A fila
  de entrada e a outbox são divididas entre as três; o balanceador fica como
  evolução.
- A auditoria das submissões não admitidas é de melhor esforço: com o banco fora do
  ar, a resposta sai igual e a linha se perde (o erro é logado).
