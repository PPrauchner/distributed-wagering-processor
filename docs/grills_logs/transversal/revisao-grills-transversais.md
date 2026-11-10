# Grill da revisão dos grills transversais

Início: 2026-11-10. Decide os pontos em aberto da revisão de `adocao.md` e
`revisao-adr-0001.md`. Já corrigidos antes da sessão, só no texto: unicidade da
reversão e seu caso de borda (`ARCHITECTURE.md`); `CHECK` da moeda repetida na
carteira e FK de moeda restrita ao lançamento (ADR 0001 e `ARCHITECTURE.md`).

## Perguntas e respostas

### 1. Quem grava `FAILED`

**P:** O redrive do SQS move a mensagem para a DLQ sem a aplicação ver; quando o
classificador diz "permanente", a transação SQL já sofreu rollback; payload inválido
nem vira transação. Quem grava o desfecho?

**R:** O consumidor. Erro permanente: uma **segunda unidade de trabalho** grava a
transação como `FAILED` (com código de falha) e o inbox, pela chave de
idempotência; depois a mensagem é enviada explicitamente à DLQ e apagada da fila.
Erro transitório: sem `ack`, backoff por `ChangeMessageVisibility`; esgotadas as
tentativas com o banco de pé, vira permanente (`INFRA_RETRIES_EXHAUSTED`); com o
banco fora, o redrive leva à DLQ sem desfecho — limitação aceita, reprocessar a DLQ
é seguro pela idempotência. Payload inválido na fila: direto à DLQ, sem transação,
com log e métrica. `FAILED` por bug é terminal para a chave; corrigido o bug, o
provedor reenvia com chave nova.

### 2. Escopo da chave de idempotência e reuso do id externo

**P:** A chave é única global ou por provedor? E o mesmo `externalTransactionId`
chegando com outra chave?

**R:** `UNIQUE (provider_id, idempotency_key)`; o replay é buscado por provedor e
chave. Mesmo id externo com chave diferente é **conflito** (mesmo desfecho HTTP do
conflito de idempotência, 409), código `EXTERNAL_ID_CONFLICT`, sem persistir nem
fazer replay da outra chave. O use case consulta `(provider, external_id)` antes de
inserir; a corrida entre carteiras diferentes cai no `23505` dessa constraint, que o
classificador mapeia para o mesmo conflito. Na fila, erro de negócio terminal (`ack`
e log). Não vira termo do glossário — é código de falha.

### 3. Tabela completa do `23505`

**P:** O classificador mapeia por nome de constraint, mas só cobria idempotência e
inbox. Qual a categoria de cada unicidade?

**R:** Critério: disputa serializada pelo lock da carteira → o domínio vê antes, e o
`23505` é bug; disputa que escapa do lock → desfecho legítimo.

| Constraint | Categoria do `23505` |
|---|---|
| `wallets (player_id, currency)` | conflito → 409 `WALLET_ALREADY_EXISTS` (único mecanismo, não rede de segurança) |
| `(provider_id, idempotency_key)` | relê e compara o hash → replay ou conflito |
| `(provider_id, external_transaction_id)` | conflito → `EXTERNAL_ID_CONFLICT` |
| `inbox (consumer_name, message_id)` | redelivery → `ack` sem efeito (nunca `FAILED`) |
| reversão única por referência | bug → permanente (`FAILED`, alerta) |
| lançamento `(transaction_id, wallet_id)` | bug → permanente (`FAILED`, alerta) |

### 4. "Sem deadlock por desenho" (ADR 0002)

**P:** O worker de `PENDING_REFERENCE` segura a linha da pendente com `SKIP LOCKED` e
depois espera a carteira; uma requisição que travou a carteira e tocasse a mesma
linha fecharia o ciclo. Como restaurar a garantia?

**R:** Regra de ordem: o lock da carteira é o primeiro lock de toda transação SQL que
toca uma carteira. Workers reivindicam com **lease** numa transação SQL curta e
separada e processam cada item numa unidade de trabalho que começa pela carteira e
relê o item; worker morto → o lease expira e outra instância assume. Vale para o
worker de referências pendentes e, por consistência, para o publicador da outbox.
Pendente resolvida só pelo worker, nunca na chegada da referência (escopo extra,
fica como melhoria). ADR 0002 corrigido.

### 5. Carteira inexistente × FK em `wager_transactions.wallet_id`

**P:** Uma `BET` com `walletId` inexistente não pode ser persistida como `REJECTED`
com FK `NOT NULL`. Abrir mão da FK, ou não persistir?

**R (contestação):** "Essa é a única opção? Gostaria de poder auditar tudo, mas a um
custo não muito alto." — levou a três opções: (a) FK `NOT NULL` e não persistir;
(b) FK nullable + `requested_wallet_id`, com `CHECK`; (c) tabela própria de
auditoria.

**R (final):** (c). Tabela append-only, sem FK, de **submissões não admitidas** —
toda submissão que não vira transação de aposta: payload inválido (HTTP ou fila),
carteira inexistente, `OPENING` de fora, conflito de idempotência,
`EXTERNAL_ID_CONFLICT`. Insert numa unidade de trabalho própria, sem unicidade;
replays ficam de fora. A FK de `wallet_id` continua `NOT NULL`; carteira inexistente
responde `WALLET_NOT_FOUND` (HTTP 422; fila, `ack`), sem evento, e o reenvio após a
criação da carteira é processado. Carteira de outro jogador segue `REJECTED`
(`WALLET_PLAYER_MISMATCH`). Termo novo no `CONTEXT.md`: **submissão não admitida**.
Complementa a decisão 1: payload inválido na fila também ganha linha, além da DLQ.

## Como ficou decidido

- `FAILED` é gravado pelo consumidor numa segunda unidade de trabalho, antes do
  envio explícito à DLQ; transitório esgotado com o banco de pé vira
  `INFRA_RETRIES_EXHAUSTED`; com o banco fora, DLQ sem desfecho (limitação).
- Chave de idempotência única por provedor; id externo reusado com outra chave é
  `EXTERNAL_ID_CONFLICT`.
- Tabela completa do `23505` no classificador, pelo critério "escapa do lock da
  carteira?" (ADR 0001 e `ARCHITECTURE.md`).
- ADR 0002: a garantia contra deadlock vem da regra "lock da carteira primeiro";
  workers reivindicam com lease em transação SQL separada; pendente só resolvida
  pelo worker.
- Submissões não admitidas auditadas em tabela própria; FK de `wallet_id` mantida
  `NOT NULL`.
