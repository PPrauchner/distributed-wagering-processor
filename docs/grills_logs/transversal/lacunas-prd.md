# Grill das lacunas do PRD

Início: 2026-11-10. Decide as lacunas encontradas na revisão do PRD (issue #2)
contra `docs/Desafio.md`, `ARCHITECTURE.md`, os ADRs e os grills anteriores: pontos
que nenhuma sessão perguntou. Prazo da entrega: quinta, 12/11/2026, 17h.

## Perguntas e respostas

### 1. Saldo observado no replay

**P:** O §7 (regra 7) manda o replay devolver o saldo observado no momento, mas só
o lançamento guarda saldo — `LOSS`, `REJECTED` e a pendente resolvida pelo worker
não têm onde buscá-lo. Coluna na transação (a) ou cálculo a partir do livro-razão
com a versão observada (b)?

**R:** (a). `wager_transactions.balance_after` (embeddable `Money`, colunas
`balance_after_amount`/`balance_after_currency`), gravado com o saldo da carteira
lido sob lock em todo desfecho `PROCESSED` ou `REJECTED` — inclusive
`CURRENCY_MISMATCH`, em que é o saldo na moeda da carteira. Nulo em
`PENDING_REFERENCE` e `FAILED`. `CHECK`: `PROCESSED`/`REJECTED` ⇔ preenchido; a
moeda do saldo não é amarrada à da transação. O trigger de transação terminal já o
torna imutável.

### 2. Referência opcional do `WIN`

**P:** O §7 permite ao `WIN` referenciar a `BET` da rodada, mas o `CHECK` "tipo
dependente ⇔ referência externa" a proíbe. Referência informativa (a), validada
sem espera (b) ou validada com `PENDING_REFERENCE` como a transação dependente (c)?

**R:** (c). Referência do `WIN` opcional; quando presente, é resolvida como a da
transação dependente — tipo `BET`, mesmo provedor, jogador, carteira, moeda e
rodada, `PROCESSED`; ausente → `PENDING_REFERENCE` e worker. O `WIN` não é
transação dependente: valor livre (não precisa igualar a referência) e não conta
como desfazer, fora do índice de reversão única; vários `WIN` podem citar a mesma
`BET`. `LOSS` não aceita referência. `CHECK`: `REFUND`/`ROLLBACK` ⇒ referência
externa preenchida; `BET`/`LOSS`/`OPENING` ⇒ nula; `WIN` livre;
`PENDING_REFERENCE` só para `REFUND`, `ROLLBACK` e `WIN`.

### 3. Transições da transação de aposta

**P:** O §6.3 manda definir e documentar as transições válidas; nenhum documento as
lista.

**R:** Tabela fechada, que entra no `ARCHITECTURE.md` com um teste de unidade por
transição:

| De | Para | Quando |
|---|---|---|
| *(create)* | `PENDING` | em memória; nunca persistido |
| `PENDING` | `PROCESSED` / `REJECTED` | a regra de negócio passa / recusa |
| `PENDING` | `PENDING_REFERENCE` | referência ainda inexistente |
| `PENDING` | `FAILED` | erro permanente (segunda unidade de trabalho) |
| `PENDING_REFERENCE` | `PROCESSED` / `REJECTED` | o worker resolve, ou o TTL expira |
| `PENDING_REFERENCE` | `FAILED` | erro permanente na resolução |
| terminais | — | `InvalidTransactionStateError` (erro de programação) |

A primeira gravação já sai em `PROCESSED`, `REJECTED`, `PENDING_REFERENCE` ou
`FAILED`; `UPDATE` de status só com `OLD.status = 'PENDING_REFERENCE'` (o trigger de
transação terminal já cobre); reagendar a pendente não muda o estado.
`markPendingReference` só sai de `PENDING`. `OPENING`: `create` → `markProcessed`.

### 4. Erros do worker de referências pendentes

**P:** O que o worker faz com erro transitório, erro permanente e TTL vencido com a
referência já presente?

**R:**

- A referência é procurada antes do TTL: presente → resolve, mesmo com o TTL
  vencido; ausente e TTL vencido → `REJECTED` (`REFERENCE_NOT_FOUND`); ausente e TTL
  vigente → `attempts++` e backoff.
- Transitório: reagenda com o mesmo backoff, métrica de retries do componente;
  sem limite de tentativas nem `INFRA_RETRIES_EXHAUSTED` — o TTL limita a vida e a
  regra acima garante o desfecho certo quando o banco volta. Sem conseguir
  reagendar, o lease expira.
- Permanente: segunda unidade de trabalho grava `FAILED`
  (`INFRA_INVARIANT_VIOLATION`/`INFRA_UNEXPECTED`), log de alerta e métrica.
- Desfecho na transação SQL que trava a carteira; item relido sob lock — se já não
  está `PENDING_REFERENCE`, sai sem efeito.

### 5. `correlationId` das pendentes

**P:** O worker resolve a pendente minutos depois; de onde vem o `correlationId` dos
eventos?

**R:** `wager_transactions.correlation_id text NOT NULL`, gravado na primeira
inserção, coluna de identidade (imutável pelo trigger). O worker o usa no contexto de
log e nos eventos (`causationId` = `transactionId`). Replay não o sobrescreve — loga o
próprio, e eventos não são reemitidos. `rejected_submissions.correlation_id`
anulável, para casar auditoria e logs.

### 6. Contratos dos eventos

**P:** O §11 só define o `data` do `WalletBalanceChanged`. Qual o `data` dos outros
três, o `aggregateId` de cada um e o `FAILED` emite evento?

**R:** Todos na `version` 1, valores em `MoneyProps`.

- `aggregateId`: `transactionId` nos eventos de transação, `walletId` no
  `WalletBalanceChanged`. A outbox ganha `wallet_id NOT NULL` para o
  `MessageGroupId`.
- `data` comum: `transactionId`, `providerId`, `externalTransactionId`, `walletId`,
  `playerId`, `roundId`, `gameId`, `kind`, `money` e `referenceExternalTransactionId`
  quando houver.
- `WagerTransactionProcessed`: + `referenceTransactionId` (se houver),
  `balanceAfter`, `walletVersion`, `processedAt`.
- `WagerTransactionRejected`: + `failureCode`, `balanceAfter`, `walletVersion`,
  `rejectedAt`.
- `WagerTransactionPendingReference`: + `expiresAt` (criação + TTL).
- `WalletBalanceChanged`: como o §11; sai com o `Processed` só quando o saldo muda.
- `FAILED` não emite evento (fora dos mínimos; falha nossa, sinalizada por log e
  métrica). `REJECTED` vindo de pendente emite `Rejected`.
- `wager_transactions.wallet_version_observed`, junto de `balance_after` (mesma
  regra de nulidade), para o `walletVersion` dos eventos de transação.

### 7. Criação de carteira idempotente

**P:** Sem chave no `POST /wallets`, o provedor que perde o 201 recebe 409 e não
descobre o `walletId`. 409 com o id (a), `Idempotency-Key` na criação (b) ou
consulta por jogador (c)?

**R (contestação):** "Não seria melhor planejar já com a b em mente? Em vez de
evoluir, capaz dessa evolução nunca chegar." — procede: com o prazo, "evolução
possível" tende a não acontecer, e o §9 cobra consistência entre endpoints. Risco
da (b) pura: o §9 mostra a criação sem header; obrigatório, um script de avaliação
que segue o enunciado receberia 400.

**R (final):** (b) com header opcional, mais (a).

- Com `Idempotency-Key`: mesma chave e hash → replay (201, `idempotentReplay: true`,
  saldo inicial, `version` 1); hash diferente → 409 `IDEMPOTENCY_CONFLICT`. Sem o
  header, o comportamento de antes.
- Sempre: carteira existente para jogador e moeda → 409 `WALLET_ALREADY_EXISTS` com
  `walletId`.
- Hash pela mesma função canônica (genérica, não presa ao comando de transação),
  sobre `playerId` e `initialBalance`.
- `wallets`: `creation_idempotency_key` (`UNIQUE`, anulável),
  `creation_payload_hash`, `CHECK` ambos nulos ou ambos preenchidos,
  `initial_balance` (`Money`) para reconstruir a resposta. Trigger novo em
  `wallets` barra mudança dessas colunas, de `player_id` e de `currency`.
- Corrida pela mesma chave: `23505` da chave → relê e compara o hash; nova linha na
  tabela do classificador.
- Chave global, porque a carteira não tem provedor e a autenticação está fora —
  limitação documentada; com autenticação, passaria a ser por provedor.

### 8. Submissão não admitida pela fila

**P:** Pela fila, `WALLET_NOT_FOUND` e os conflitos terminavam em `ack`, sem retorno
ao provedor — uma `BET` enviada logo após criar a carteira por HTTP sumiria.
Limitação (a), evento novo (b) ou DLQ (c)?

**R:** (c). Na fila, toda submissão não admitida termina na DLQ, o canal de "precisa
de atenção":

- `WALLET_NOT_FOUND` é transitório na fila: sem `ack`, backoff por
  `ChangeMessageVisibility`; esgotados os 5 recebimentos (~30 s), envio explícito à
  DLQ, sem `FAILED` (não há transação).
- `IDEMPOTENCY_CONFLICT`, `EXTERNAL_ID_CONFLICT` e `OPENING` de fora vão direto à
  DLQ, como payload inválido e `MESSAGE_ID_CONFLICT`.
- Todo envio à DLQ leva o atributo `failureCode`, uma linha em
  `rejected_submissions` (no envio final, não a cada recebimento) e a métrica de DLQ
  por motivo.
- `ack` puro só para desfechos de transação (`PROCESSED`, `REJECTED`), que emitem
  evento — o "erro de negócio → `ack`" do §10 vale para a rejeição. Reprocessar a
  DLQ depois de corrigida a causa é seguro pela idempotência. HTTP inalterado.

### 9. Ordem das validações

**P:** Com mais de uma violação, qual código prevalece?

**R:** Ordem fixa, igual nos dois canais; tabela no `ARCHITECTURE.md` e testes de
unidade com duas violações combinadas.

1. Chave ausente → `MISSING_IDEMPOTENCY_KEY` (na fila, `INVALID_PAYLOAD`).
2. Forma do payload → `INVALID_PAYLOAD`; `OPENING` bem formado →
   `INTERNAL_KIND_NOT_ALLOWED`.
3. Hash do payload.
4. Idempotência por `(provider, chave)`, sem lock → replay ou
   `IDEMPOTENCY_CONFLICT` — antes da carteira: chave reusada com carteira
   inexistente é conflito.
5. Id externo com outra chave → `EXTERNAL_ID_CONFLICT`.
6. Lock da carteira; inexistente → `WALLET_NOT_FOUND`.
7. 4 e 5 de novo, sob lock (concorrente que confirmou no meio-tempo).
8. Domínio: `WALLET_PLAYER_MISMATCH` → `CURRENCY_MISMATCH` → referência (ausente ou
   pendente → espera; `REFERENCE_NOT_PROCESSED`; `REFERENCE_KIND_NOT_ALLOWED`;
   `REFERENCE_MISMATCH` com o primeiro campo divergente na ordem provedor, jogador,
   carteira, moeda, rodada; `REFERENCE_AMOUNT_MISMATCH`, exceto `WIN`;
   `REFERENCE_ALREADY_REVERSED`, só transação dependente) → saldo
   (`INSUFFICIENT_FUNDS` / `REVERSAL_INSUFFICIENT_FUNDS`).

### 10. Teto e piso de valor

**P:** Nada limita a entrada; valor ou saldo além de `numeric(19,2)` chegaria ao
banco como `22003`, fora do classificador.

**R:**

- Teto de entrada: `Money.from` recusa mais de 15 dígitos inteiros (máximo
  `"999999999999999.99"`) → 400 `INVALID_PAYLOAD`; duas ordens de grandeza de folga
  até a coluna.
- Estouro do saldo: sem código de negócio; `22003` no classificador como permanente
  (`INFRA_INVARIANT_VIOLATION`, alerta), limitação documentada.
- Piso no passo 2 da ordem de validações (`INVALID_PAYLOAD`), repetido no `CHECK`:
  `BET`, `WIN`, `REFUND`, `ROLLBACK` > 0; `LOSS` >= 0; `initialBalance` >= 0.
- Teste de unidade do `Money` nos limites (15 dígitos passa, 16 não).

### 11. Pendências pequenas

**P:** Padrões para os pontos menores.

**R:** Fechados em bloco:

- `Retry-After: 1` (segundos), configurável.
- `limit` fora de 1..200 ou não numérico → 400 `INVALID_PAYLOAD`.
- Moeda validada por `^[A-Z]{3}$`, sem lista ISO completa; divergência da carteira
  é `CURRENCY_MISMATCH`.
- `GET` de transação: corpo do desfecho da submissão mais os campos de identidade,
  sem `idempotentReplay`. Item do livro-razão: `id`, `transactionId`, `direction`,
  `money`, `balanceBefore`, `balanceAfter`, `walletVersion`, `createdAt`.
- DLQ: contador dos envios da aplicação por motivo e *gauge*
  `ApproximateNumberOfMessages` da DLQ no scrape (cobre o redrive).
- "Arredondamento" (§13): nada é arredondado; mais de 2 casas é recusado. Testes da
  recusa e da soma exata.
- Sem máquina de estados da rodada: `WIN` sem `BET`, `WIN` e `LOSS` na mesma rodada
  são aceitos; a rodada só entra na coerência da referência. Interpretação
  documentada.
- `MESSAGE_ID_CONFLICT` grava linha em `rejected_submissions`.
- TTL e leases pelo `now()` do banco, nunca pelo relógio da instância.
- 3 instâncias no Compose por `--scale app=3`, documentado no README; os testes
  seguem com `Bun.spawn`.
- Desenho do Keycloak: issue própria de documentação, com o README.

## Como ficou decidido

- `wager_transactions` ganha `balance_after` e `wallet_version_observed` (todo
  `PROCESSED`/`REJECTED`) e `correlation_id`; o replay devolve o saldo gravado.
- `WIN` com referência opcional, resolvida como a da transação dependente (inclusive
  `PENDING_REFERENCE`), sem igualdade de valor e sem contar como desfazer; `LOSS` sem
  referência; `CHECK` reescrito.
- Tabela de transições da transação de aposta, com `PENDING_REFERENCE → FAILED`.
- Worker de pendentes: referência antes do TTL; transitório reagenda sem limite;
  permanente grava `FAILED`.
- Contratos dos quatro eventos; outbox com `wallet_id`; `FAILED` sem evento.
- `POST /wallets` com `Idempotency-Key` opcional (replay e conflito); 409 de
  carteira existente sempre com `walletId`; trigger de imutabilidade em `wallets`.
- Na fila, toda submissão não admitida termina na DLQ; `WALLET_NOT_FOUND` passa
  antes pelo retry transitório.
- Ordem fixa das validações, idempotência antes da carteira.
- Teto de 15 dígitos inteiros na entrada; `22003` permanente; piso por tipo.
- Pendências pequenas fechadas com os padrões da pergunta 11.
