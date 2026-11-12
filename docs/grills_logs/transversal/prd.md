# Grill do PRD da solução

Início: 2026-11-10. Decide o que o enunciado deixa ao candidato e ainda estava em
aberto depois da adoção e das revisões (`adocao.md`, `revisao-adr-0001.md`,
`revisao-grills-transversais.md`), para gerar o PRD. Prazo da entrega: quinta,
12/11/2026, 17h.

## Perguntas e respostas

### 1. Submissão HTTP síncrona ou assíncrona

**P:** O `POST /wagering/transactions` executa o use case na requisição e responde
o desfecho final (a), ou só aceita (`PENDING`/fila), responde 202 e um worker
processa depois (b)?

**R (contestação):** "Realmente não traz nenhum ganho?" — o assíncrono ganha:
requisição que não espera o lock da carteira (sem 503 por `lock_timeout`),
absorção de pico e um só caminho de processamento (reaproveitando o worker com
lease). Perde: o §9 mostra a resposta com desfecho e saldo, e o replay devolve o
saldo observado; o provedor precisa saber na hora se a `BET` passou; o §10 supõe que
a entrada HTTP executa o use case; os testes de concorrência passariam a depender de
polling (menos determinismo); `PENDING` persistido vira estado observável a mais.

**R (final):** (a), síncrono. A resposta traz `PROCESSED` ou `REJECTED` com saldo;
o único aceite pendente é `PENDING_REFERENCE`. `PENDING` existe só em memória
dentro da unidade de trabalho e nenhum caminho o persiste — interpretação a
documentar. Carteira disputada responde 503 com `Retry-After` no estouro do lock;
a chave de idempotência torna o reenvio seguro. O assíncrono entra no
`ARCHITECTURE.md` como alternativa considerada e evolução para carteiras muito
disputadas.

### 2. Mapeamento dos status HTTP

**P:** Que código para cada situação que o §9 manda distinguir, e o erro
permanente pela entrada HTTP grava `FAILED`?

**R:** Tabela única para todos os endpoints:

| Situação | HTTP |
|---|---|
| `PROCESSED` (original ou replay) | 200 |
| `PENDING_REFERENCE` | 202 |
| payload inválido, `Idempotency-Key` ausente, `OPENING` de fora | 400 |
| conflito de idempotência, `EXTERNAL_ID_CONFLICT`, `WALLET_ALREADY_EXISTS` | 409 |
| `REJECTED` (original ou replay), `WALLET_NOT_FOUND` | 422 |
| falha transitória (lock, deadlock, banco fora) | 503 + `Retry-After` |
| `FAILED` / erro permanente | 500 |
| recurso inexistente num `GET` | 404 |

4xx = não reenvie igual; 503 = reenvie com a mesma chave. O replay devolve o mesmo
código do original, com `idempotentReplay: true`. Erros sem transação respondem
`{ failureCode, message }`.

A gravação do `FAILED` numa segunda unidade de trabalho passa do consumidor para o
**use case** (camada de aplicação), compartilhada pelas duas entradas: o HTTP
responde 500 com `transactionId` e `failureCode`, e o replay devolve o mesmo 500.
`FAILED` é terminal para a chave nos dois canais.

### 3. Algoritmo do hash do payload

**P:** Quais campos, que canonização e que hash?

**R:** Entram `providerId`, `externalTransactionId`, `playerId`, `walletId`,
`roundId`, `gameId`, `kind`, `money.amount`, `money.currency` e
`referenceExternalTransactionId` (omitido quando ausente, nunca `null`). Ficam de
fora a chave de idempotência, `messageId`, `type`, `occurredAt` e headers — o
reenvio pelo outro canal dá o mesmo hash e é replay. O hash é do comando já
validado; campo desconhecido no corpo é **400 (estrito)**, para que dois payloads
diferentes nunca compartilhem hash. JSON canônico (chaves ordenadas
recursivamente, sem espaços, UTF-8), serializador próprio; SHA-256 em hex
minúsculo, `char(64)`. Função pura em `wagering/application`, comum às duas
entradas, com teste por campo excluído e teste de igualdade entre HTTP e fila.

### 4. Worker de referências pendentes

**P:** Backoff, limite de tentativas ou TTL, e os casos de borda da referência.

**R:**

- **TTL de 5 minutos** desde a criação, configurável (≈2 s nos testes): o que
  importa ao provedor é o tempo, não o número de tentativas, que depende do
  intervalo interno. Esgotado → `REJECTED` (`REFERENCE_NOT_FOUND`) e
  `WagerTransactionRejected`.
- **Backoff:** `next_attempt_at = now + min(1 s × 2^attempts, 60 s)`, jitter ±20%;
  polling a cada 1 s; lease de 30 s. `attempts` e `next_attempt_at` em
  `wager_transactions`, índice parcial `WHERE status = 'PENDING_REFERENCE'`.
- **Casos de borda** (na chegada e em cada tentativa): referência inexistente ou
  ela mesma `PENDING_REFERENCE` → espera; `REJECTED`/`FAILED` →
  `REJECTED` (`REFERENCE_NOT_PROCESSED`) na hora; outro jogador, carteira, moeda,
  rodada ou tipo errado → `REJECTED` com o código específico, na hora; já desfeita
  → `REFERENCE_ALREADY_REVERSED`.
- **Replay de pendente devolve o estado atual** (200 `PROCESSED` se o worker já
  resolveu); "resultado original" vale para desfechos terminais.

### 5. Publicador da outbox

**P:** Destino, o que conta como publicado, backoff, limite, ordem e lag.

**R:**

- **Destino:** fila `wagering-events.fifo`; `MessageGroupId` = `walletId`,
  `MessageDeduplicationId` = `eventId` (otimização do broker, não garantia).
- **Publicado** = `SendMessageBatch` com sucesso para o item; `published_at`
  gravado numa transação SQL curta. Morte entre envio e gravação → o lease expira e
  outra instância reenvia: at-least-once, o consumidor deduplica pelo `eventId`,
  estável desde o `enqueue`.
- Polling a cada 500 ms, lotes de até 10, lease de 30 s; falha → `scheduleRetry`
  com `min(1 s × 2^attempts, 5 min)` e jitter. **Sem limite de tentativas** —
  desistir perderia evento confirmado (§3); a partir de 10 tentativas, métrica e
  log de alerta.
- **Ordem** entre publicadores não é garantida; o consumidor ordena por
  `walletVersion`/`occurredAt`. Limitação documentada.
- **Outbox lag** = `now() − min(occurred_at)` das não publicadas.
- Linhas publicadas não são expurgadas (limitação; expurgo é melhoria futura).

### 6. Consumidor SQS

**P:** Recepção, limite antes da DLQ, inbox e `SIGTERM`.

**R:**

- Long polling de 20 s, lotes de 10 processados em paralelo, visibilidade de 30 s.
  O agrupamento FIFO por carteira é otimização; a correção vem do lock.
- **Limite da aplicação: 5 recebimentos**; esgotado com o banco de pé →
  `INFRA_RETRIES_EXHAUSTED`, `FAILED`, DLQ. **`maxReceiveCount` do redrive: 6**,
  rede de segurança para o banco fora. Backoff do transitório por
  `ChangeMessageVisibility` = `min(2^receiveCount s, 60 s)`.
- **Inbox:** `consumerName` = `wager-transactions-consumer`; `messageId` do
  envelope do §10, não o do SQS; `payloadHash` pela função da pergunta 3 sobre
  `data`. Gravado na transação SQL de todo desfecho (o de `FAILED`, na segunda
  unidade de trabalho). Mesmo `messageId` com hash diferente → permanente, DLQ,
  `MESSAGE_ID_CONFLICT`. Submissões não admitidas não gravam inbox: `ack` e linha na
  tabela própria.
- **`SIGTERM`:** para polling e reivindicações; espera as mensagens em andamento
  até 20 s (`stop_grace_period` 30 s); devolve as não iniciadas com visibilidade 0;
  fecha HTTP e pool. Estourou: a transação SQL é atômica e a redelivery é segura;
  leases expiram.

### 7. Schema

**P:** Constraints, índices e triggers que levam as invariantes da §6 ao banco.

**R:** Fechado:

- `wallets`: `CHECK` de saldo `>= 0`, `version >= 1`, moeda repetida igual;
  `UNIQUE (player_id, currency)` e `UNIQUE (id, currency)`.
- `wager_transactions`: `UNIQUE (provider_id, idempotency_key)`,
  `UNIQUE (provider_id, external_transaction_id)`; FK `wallet_id NOT NULL`; FK
  `reference_transaction_id` na própria tabela; índice único parcial da reversão;
  `CHECK`s de coerência (tipo dependente ⇔ referência externa; `PROCESSED` ⇔
  `processed_at`; `REJECTED`/`FAILED` ⇔ `failure_code`; `status <> 'PENDING'`);
  `amount > 0`, exceto `LOSS` (`>= 0`); índice parcial dos pendentes.
- `wallet_ledger_entries`: `UNIQUE (transaction_id, wallet_id)`; moeda amarrada
  (FK composta e `CHECK`); `amount > 0`; `CHECK` da aritmética
  (`balance_after = balance_before ± amount`, saldos `>= 0`); trigger contra
  `UPDATE`/`DELETE`/`TRUNCATE`.
- `inbox_messages` PK `(consumer_name, message_id)`; `outbox_messages` com índice
  parcial das não publicadas; `rejected_submissions` sem FK nem unicidade.
- UUIDv7 gerado na aplicação; datas em `timestamptz`.
- **Trigger novo 1 — saldo ↔ livro-razão:** *constraint trigger*
  `DEFERRABLE INITIALLY DEFERRED` em `wallets` exige, no commit, um lançamento com
  `balance_before = OLD.balance` e `balance_after = NEW.balance` para toda mudança
  de saldo (na criação com saldo inicial, o lançamento da abertura), e
  `version = OLD.version + 1` quando o saldo muda, igual quando não muda.
- **Trigger novo 2 — transação terminal imutável:** `BEFORE UPDATE OR DELETE` em
  `wager_transactions` impede alterar linha terminal, alterar colunas de
  identidade em qualquer estado e apagar linhas.
- Violação de qualquer trigger é permanente no classificador (`FAILED`, alerta).
  Um teste de integração por trigger, por SQL cru.

### 8. Paginação do livro-razão

**P:** Como fazer o cursor estável e opaco? Paginar pelo `id` UUIDv7 depende do
relógio de cada instância: com relógios dessincronizados, um lançamento posterior
pode ganhar id menor e cair numa página já lida.

**R:** Paginar pela **versão da carteira**. Cada lançamento guarda
`wallet_version` (a versão depois dele; abertura = 1); como só lançamentos mudam o
saldo e só mudança de saldo sobe a versão, a sequência por carteira é contínua e
ordenada pelo lock. `UNIQUE (wallet_id, wallet_version)` substitui o índice
`(wallet_id, id)`; o trigger 1 exige `entry.wallet_version = NEW.version`. A
reconciliação ganha detecção de buraco na sequência, e `checkedEntries` deve igualar
a versão atual.

Ordem crescente; cursor `base64url("v1:<walletId>:<wallet_version>")` — o
`walletId` no cursor permite recusar cursor de outra carteira; cursor malformado ou
alheio → 400. `limit` padrão 50, máximo 200, fora disso 400. Resposta
`{ items, nextCursor | null }`. Leitura sem lock.

### 9. Observabilidade

**P:** Bibliotecas, contexto dos logs, métricas e health checks.

**R:**

- **Logs:** pino atrás de um adaptador do `LoggerService` do Nest; contexto por
  `AsyncLocalStorage` (`correlationId`, `messageId`, `transactionId`, `walletId`,
  `providerId`). `correlationId` do header `X-Correlation-Id` (ou gerado) no HTTP,
  do atributo `correlationId` (ou do `messageId`) na fila; propagado aos eventos,
  com `causationId` = `transactionId`. Só identificadores, `kind`, `status` e
  `failureCode` — nunca valores nem payload; `redact` do pino como rede.
- **Métricas:** prom-client em `GET /metrics`, aberto: transações por
  `kind`/`status`/canal, replays, conflitos de idempotência, duplicatas do inbox,
  retries por componente, DLQ por motivo, conflitos de lock (`lock_timeout`,
  deadlock), `outbox_lag_seconds` e `outbox_pending` (do banco, no scrape),
  histograma de latência por canal e tipo, divergências de reconciliação e
  submissões não admitidas por código.
- **Health:** `/health/live` 200 enquanto o processo responde; `/health/ready`
  com `SELECT 1` e `GetQueueAttributes`, timeout de 1 s cada, 503 se algum falhar.
  Controller próprio, sem `@nestjs/terminus`.
- OpenTelemetry e dashboard ficam para os diferenciais.

### 10. Estratégia de testes

**P:** Suítes, isolamento, como provar os cenários difíceis e qual comando o hook
roda.

**R:**

- Suítes em `bun test`: `test:unit` (sem I/O), `test:integration` (app em processo
  contra PostgreSQL e LocalStack reais), `test:concurrency` (os 8 cenários do §13)
  e `test` = unit + integration.
- **Isolamento sem limpeza:** banco `wagering_test` recriado por execução com as
  migrations; ids próprios por teste; filas com sufixo aleatório por arquivo.
- **≥ 3 instâncias:** 3 processos reais por `Bun.spawn`, carga por HTTP e fila.
- **Crash após commit e antes do `ack`** e **publicador morto entre envio e
  `published_at`:** porta `FaultInjector`, no-op por padrão, ativada por variável de
  ambiente só nos testes (`crash-after-commit`, `crash-after-send`).
- **Reinício:** `SIGKILL` no meio da carga, nova subida, espera da quiescência.
- `assertLedgerConsistent()` (saldo = saldo reconstruído, versões sem buraco) em
  todo teste de integração e concorrência.
- Determinismo: `waitUntil(condição, timeout)`, nunca `sleep`; tempos curtos por
  configuração.
- **Hook:** `Test command: \`bun run test\`` (unit + integration, Compose de pé); a
  concorrência roda à mão e antes da entrega. A linha muda no
  `project-constraints.md` quando o scaffold criar o script — antes disso o hook
  negaria todo commit.

### 11. Diferenciais

**P:** Quais diferenciais entram, dado o prazo?

**R (pergunta do autor):** "O ponto 3 fica de fora fora ou fica de fora do MVP?" —
não há "depois do MVP": a entrega de quinta é o produto final. Partidas dobradas
mexeria no livro-razão, no trigger 1, na reconciliação e na regra de um lançamento
por carteira — o núcleo de 20 pontos, perto do prazo. OpenTelemetry é de menor
risco, mas é infraestrutura nova sem pontos.

**R (final):** nenhum diferencial no escopo do PRD. Fila "se sobrar tempo": (1)
endurecer o que existe; (2) `test:load`, que reaproveita o harness de 3 processos,
só depois das 8 provas do §13 verdes e de `README.md`/`ARCHITECTURE.md` completos.
Partidas dobradas e OpenTelemetry ficam fora da entrega, descritos no
`ARCHITECTURE.md` como evolução possível; autenticação segue só no desenho.

### 12. Taxonomia dos códigos de falha

**P:** A taxonomia completa exigida pelo §7.2.

**R:** Enum fechado em `shared/domain`; cada código com "o que o provedor deve
fazer" no `ARCHITECTURE.md`.

- **Rejeição** (`REJECTED`, 422, `WagerTransactionRejected`):
  `INSUFFICIENT_FUNDS`, `REVERSAL_INSUFFICIENT_FUNDS`, `CURRENCY_MISMATCH`,
  `WALLET_PLAYER_MISMATCH`, `REFERENCE_NOT_FOUND`, `REFERENCE_NOT_PROCESSED`,
  `REFERENCE_KIND_NOT_ALLOWED`, `REFERENCE_MISMATCH` (um código para provedor,
  jogador, carteira, moeda ou rodada; o campo divergente vai no `message`),
  `REFERENCE_AMOUNT_MISMATCH`, `REFERENCE_ALREADY_REVERSED`.
- **Submissão não admitida:** 400 `INVALID_PAYLOAD`, `MISSING_IDEMPOTENCY_KEY`,
  `INTERNAL_KIND_NOT_ALLOWED`, `INVALID_CURSOR`; 409 `IDEMPOTENCY_CONFLICT`,
  `EXTERNAL_ID_CONFLICT`, `WALLET_ALREADY_EXISTS`; 422 `WALLET_NOT_FOUND`; só na
  fila, DLQ: `MESSAGE_ID_CONFLICT`.
- **Falha** (`FAILED`, 500): `INFRA_RETRIES_EXHAUSTED`,
  `INFRA_INVARIANT_VIOLATION` (bug, alerta), `INFRA_UNEXPECTED`.
- **Transitório** (503 + `Retry-After`): `TRANSIENT_LOCK_TIMEOUT`,
  `TRANSIENT_UNAVAILABLE`.
- `GET` inexistente: 404 `NOT_FOUND` — `WALLET_NOT_FOUND` fica só na submissão.

### 13. Criação de carteira e reconciliação

**P:** Saldo inicial zero, eventos da abertura e o contrato da reconciliação.

**R:**

- **`POST /wallets`:** saldo inicial zero é permitido — sem abertura nem
  lançamento, `version` 1; negativo → 400. Saldo positivo gera a abertura
  (`provider_id` = `internal`, chave `opening:<walletId>`), `PROCESSED`, com
  lançamento `CREDIT` de `wallet_version` 1 e eventos `WagerTransactionProcessed` e
  `WalletBalanceChanged`, na mesma transação SQL.
- **Sequência de versões:** contínua até a versão atual, começando em 1 com
  abertura e em 2 sem ela; `checkedEntries` segue a regra.
- **Reconciliação:** só leitura, sem lock, numa única consulta (snapshot
  consistente): saldo, soma com sinal, contagem e buracos. Resposta do §9 mais
  `versionGaps`. Divergência (valor ou buraco) → `consistent: false`, log `error`,
  métrica; nada é corrigido; HTTP 200 (relatório). Sem reconciliação agendada
  (evolução possível).

## Como ficou decidido

- HTTP síncrono; `PENDING` nunca persistido; 503 + `Retry-After` na carteira
  disputada. O assíncrono é alternativa documentada.
- Tabela única de status HTTP; `FAILED` gravado pelo use case nos dois canais.
- `payloadHash`: SHA-256 hex de JSON canônico dos campos de negócio, sem chave nem
  metadados de transporte; campo desconhecido é 400.
- Pendentes: TTL de 5 min, backoff exponencial até 60 s, casos de borda resolvidos
  na hora; replay de pendente devolve o estado atual.
- Outbox: `wagering-events.fifo`, publicado = envio com sucesso, at-least-once com
  dedup por `eventId`, sem limite de tentativas, ordem não garantida.
- Consumidor: limite de 5 recebimentos na aplicação e 6 no redrive; inbox pelo
  `messageId` do envelope; `SIGTERM` com 20 s de drenagem.
- Schema: as constraints da §6 mais dois triggers — saldo ↔ livro-razão (deferido)
  e transação terminal imutável.
- Livro-razão paginado por `wallet_version`, sequência contínua; cursor opaco
  `v1:<walletId>:<versão>`.
- Observabilidade: pino, prom-client em `/metrics`, health próprio.
- Testes: unit, integration, concurrency; `FaultInjector` para os crashes; hook
  roda `bun run test` quando o script existir.
- Diferenciais: nenhum no escopo; `test:load` só se sobrar tempo.
- Taxonomia fechada dos códigos de falha.
- Carteira com saldo zero sem abertura; reconciliação só leitura, com
  `versionGaps`.
