# Grill dos achados da avaliação por área do §14

Início: 2026-11-11. Oito subagentes avaliaram o repositório, cada um contra uma
linha da tabela de avaliação do §14 de `docs/Desafio.md`. Os achados já cobertos por
issues abertas (#35 guard de identidade, #18 README/ARCHITECTURE, #34 `--scale`,
#1 modelo de dados) ficaram fora. Esta sessão decide **o que precisa ser feito** em
cada achado restante; o corte por prazo não é assunto desta sessão. Ao final sai um
PRD novo ou as issues das correções.

Notas estimadas pelos avaliadores (soma ≈ 84,5/100): correção financeira 18/20,
concorrência 18/20, idempotência 13/15, mensageria e falhas 13/15, modelagem e
arquitetura 7/10, testes 8,5/10, observabilidade 4/5, documentação 3/5.

## Perguntas e respostas

### 1. Retries transitórios esgotados na fila

**P:** Esgotadas as tentativas transitórias (ex.: cinco `lock_timeout` numa carteira
disputada), o consumidor grava `FAILED` `INFRA_RETRIES_EXHAUSTED`, terminal para a
chave: o redrive da DLQ cai em `FailedRedeliveryError` e o replay HTTP responde 500
para sempre. O `CONTEXT.md` define **Falha** como erro *permanente* e **Falha
transitória** como *sem desfecho*; o §6.3 também diz que `FAILED` é permanente.
Manter e ajustar o vocabulário (a) ou ir à DLQ sem gravar `FAILED` (b)?

**R:** (b). Esgotar as tentativas transitórias manda a mensagem à DLQ como submissão
sem desfecho — o mesmo caminho da carteira inexistente (envio explícito à DLQ,
linha em `rejected_submissions`) —, sem gravar transação de aposta. A chave fica
livre: reprocessar a DLQ ou reenviar pelo HTTP com a mesma chave aplica a transação.
O `giveUp` do use case deixa de existir; `INFRA_RETRIES_EXHAUSTED` deixa de ser
desfecho `FAILED` (passa a ser só o código do envio à DLQ). `CONTEXT.md` atualizado
(**Falha transitória**: esgotada, termina sem desfecho, nunca vira **Falha**). O
`ARCHITECTURE.md` (tabela de códigos, "Quem grava `FAILED`", fila, limitações) é
alinhado na implementação.

### 2. Deadlock na gravação de `FAILED`

**P:** `recordFailure` insere a transação sem travar a carteira; a FK `wallet_id`
toma `FOR KEY SHARE`, que conflita com o `FOR UPDATE`. Duas submissões da mesma
chave — uma gravando `FAILED`, outra no caminho normal — podem fechar um ciclo
(`40P01`), contrário ao "sem deadlock por desenho" do ADR 0002. Travar a carteira
primeiro em `recordFailure` (a) ou trocar o lock por `FOR NO KEY UPDATE` (b)?

**R:** (a). Contra o `Desafio.md`, (a) conversa melhor: mantém o `LockMode` do ORM
(motivo da preferência pelo MikroORM no §4), uma regra única de ordem é a estratégia
mais simples de justificar (§8, §14 "simplicidade"). `recordFailure` começa por
`findByIdForUpdate`. ADR 0002 atualizado: o `lock_timeout` vale para a transação
SQL que trava a carteira (o que o código faz); `FOR NO KEY UPDATE` entra em
"Considered Options" como descartado; nova emenda: *inserir uma linha com FK para a
carteira também é tocá-la*. Fica pendente contar `lockConflict` também no worker de
referências pendentes e na criação de carteira (ver pergunta de métricas).

### 3. API de domínio de `WagerTransaction`

**P:** Faltam `rehydrate` (existe em todas as outras entidades;
`ARCHITECTURE.md:76` diz que existe), `requiresReference` (Set privado
`KINDS_REQUIRING_REFERENCE`), `ledgerDirectionFor` (`DEBITING_REFERENCE_KINDS` em
`dependent-transaction.ts` e direção implícita em `bet.ts`/`win.ts`),
`matchesPayload` (um `!==` em `findEarlier`, na aplicação) e `affectsBalance`. Falta
o teste unitário de chave com payload divergente (§13). `SUPPORTED_KINDS` e
`UnsupportedKindError` são código morto. Completo e usado pelo código (a), fachada
(b) ou documentar o desvio (c)?

**R:** (a), e inclui a validação de identificadores. Os cinco métodos entram na
classe e **substituem** os Sets e o `!==` nos pontos que hoje decidem por eles; um
teste de unidade por método, incluindo o de chave com payload divergente. Apagar
`SUPPORTED_KINDS`, `UnsupportedKindError` e o mapeamento correspondente no filtro
HTTP. A validação de identificadores (1–255 caracteres de `providerId`, `playerId`,
`roundId` etc., hoje em `assertIdentifiers` no use case) passa para
`WagerTransaction.create` — o §2 diz que a identidade do provedor é sujeita às
validações *de domínio*, e `Wallet.open` já valida o `playerId` no domínio.

### 4. Saldo além do teto de entrada

**P:** O `Money` aceita até 15 dígitos inteiros na entrada, mas a soma não tem teto:
dois `WIN` máximos levam o saldo a 16 dígitos, e a reconciliação (que monta com
`Money.from`) responde 400 `INVALID_PAYLOAD`, sem relatório nem métrica. Além de 17
dígitos, `numeric(19,2)` estoura (`22003` → `FAILED` `INFRA_INVARIANT_VIOLATION`).
`ARCHITECTURE.md:756` diz "inalcançável". Só uma factory para valores persistidos
(a), ou isso mais um saldo máximo no domínio com rejeição (b)?

**R:** (b), com o limite técnico da coluna: **saldo máximo = `99999999999999999.99`**.
- Factory interna para valor já persistido (ex.: `Money.fromPersisted`), sem o teto
  de entrada, usada na reconciliação e em toda leitura de valor vindo do banco.
- A carteira recusa o crédito que ultrapassaria o saldo máximo: `REJECTED` com
  código novo `BALANCE_LIMIT_EXCEEDED` (422, ação do provedor: desistir), sem
  lançamento, auditável com o saldo observado. Vale para todo crédito — `WIN`,
  `REFUND`, `ROLLBACK` de `BET` e `OPENING` (na criação de carteira, saldo inicial
  acima do máximo é inválido).
- `CHECK` no schema reforçando o saldo máximo (restrição 9); o `22003` volta a ser só
  rede de segurança.
- `ARCHITECTURE.md` corrige "inalcançável" e ganha a linha do código novo.
- `CONTEXT.md`: termo **Saldo máximo**.

### 5. Lançamento amarrado à transação no schema

**P:** O schema garante a aritmética, a imutabilidade, um lançamento por
(transação, carteira), a moeda da carteira e "mudança de saldo ⇒ lançamento". Não
garante: (1) transação `PROCESSED` e não-`LOSS`; (2) valor, moeda e carteira iguais
aos da transação; (3) direção coerente com o tipo; (4) o "vice-versa" do §6.2
(lançamento sem mudança de saldo). Quais entram?

**R:** Os quatro, numa migration nova e reversível:
1. Trigger na inserção do lançamento exigindo transação `PROCESSED` e
   `kind <> 'LOSS'` (a transação terminal já é imutável, então basta checar na
   inserção; se a ordem dos inserts do ORM não acompanhar, o trigger vira deferido).
2. FK composta `(transaction_id, wallet_id, amount, currency)` → `UNIQUE`
   equivalente em `wager_transactions`.
3. No mesmo trigger: `BET` ⇒ `DEBIT`; `WIN`, `REFUND`, `OPENING` ⇒ `CREDIT`;
   `ROLLBACK` ⇒ inverso da direção do lançamento da referência.
4. Constraint trigger deferido em `wallet_ledger_entries`: no commit, a carteira
   está numa versão ≥ `wallet_version` do lançamento, e o lançamento mais recente da
   carteira tem `balance_after` igual ao saldo dela.

Cada garantia com teste de integração que tenta violá-la por SQL direto. Entra na
tabela de invariantes (issue #1) e no `ARCHITECTURE.md`.

### 6. Ordem FIFO dentro do lote do consumidor

**P:** O consumidor recebe até 10 mensagens e as processa com `Promise.all`
(`wager-transaction.consumer.ts:300`), desfazendo a ordem de mensagens do mesmo
grupo no lote; se a primeira vai a retry e a segunda é apagada, a ordem do grupo se
inverte de vez. Em série por grupo (a) ou documentar (b)?

**R:** (a). O lote é particionado pelo atributo `MessageGroupId` recebido (não pelo
`walletId` do corpo — a ordem do SQS é por grupo do broker): em série dentro do
grupo, grupos em paralelo. Quando uma mensagem do grupo vai a retry, as seguintes do
mesmo grupo no lote não são processadas e voltam com visibilidade 0. O `receive`
passa a pedir o atributo `MessageGroupId`. Teste de integração: `BET` e `ROLLBACK`
da mesma carteira no mesmo lote, em ordem, e o caso de retry da primeira.

Achado ao responder: o grupo da fila de **entrada** não estava documentado (só o da
fila de eventos e o da DLQ). Contrato do produtor, a documentar no `ARCHITECTURE.md`
e no README: `MessageGroupId` = `walletId` (unidade de concorrência do §8) e
`MessageDeduplicationId` = `messageId` do envelope.

### 7. Métricas e diagnóstico

**P:** O worker de pendentes não alimenta métrica; conflitos de lock só contam na
submissão; a outbox não conta retries e o alerta de 10 tentativas
(`ARCHITECTURE.md:545`) não existe; "DLQ" é contador de envios por processo; a
latência só mede sucesso; o readiness engole o erro; a divergência de reconciliação
leva o `walletId` só no texto; `ARCHITECTURE.md:653` diz que todas as métricas
existem desde a partida, mas as séries com label só nascem no primeiro incremento.

**R:** Os oito:
1. Worker de pendentes: desfecho em `wager_transactions_total{channel="worker"}`,
   `lock_timeout` em `lock_conflicts_total`, reagendamento em
   `pending_reference_retries_total`.
2. Criação de carteira: conflitos de lock em `lock_conflicts_total`.
3. Outbox: `outbox_publish_retries_total` a cada `scheduleRetry`; na 10ª tentativa,
   log `alert`; gauge `outbox_stuck_messages` (`attempts >= 10`, não publicadas) na
   mesma leitura de `outbox_pending`/`outbox_lag_seconds`.
4. DLQ: gauge `wager_transactions_dlq_depth` por `ApproximateNumberOfMessages` no
   scrape (timeout e último valor, como os gauges da outbox); o contador de envios
   fica.
5. Latência: histograma também nos caminhos de erro, com label `outcome`.
6. Readiness: log `warn` com sonda e tipo de erro; 503 com `reason` curto por sonda
   (nome do erro, sem stack); sonda da DLQ incluída.
7. Divergência de reconciliação logada pelo logger estruturado, `walletId` como
   campo.
8. Pré-registro em zero das séries com label de combinações conhecidas
   (`channel`, `reason`); lista de métricas do `ARCHITECTURE.md` reunida e
   atualizada.

### 8. Rigor dos testes

**P:** O invariante final não roda em todos os testes
(`wager-transaction-query-http.test.ts` não o checa; `wallet-persistence.test.ts`
checa uma carteira); a atomicidade em falha não confere outbox/inbox; o cenário 5
"morre" por exceção engolida e só leva SIGKILL depois (janela de 5 s); o cenário 2
não garante sobreposição; a duplicata de evento nunca chega ao consumidor (dedup do
FIFO em 5 min); há `Bun.sleep` fixo e `waitFor` duplicado; não há CI.

**R:** Os sete:
1. `afterAll` global no preload de integração e de concorrência reconcilia **todas**
   as carteiras do banco de teste (saldo = ledger, sem buraco de versão); os testes
   que corrompem de propósito registram a carteira numa lista de exceção por helper.
   Checagens por arquivo continuam.
2. Testes de falha permanente (HTTP e fila) afirmam também outbox sem linha nova e
   inbox só com o que a segunda unidade de trabalho gravou.
3. Cenário 5: o ponto `crash-after-commit` faz `process.kill(process.pid, 'SIGKILL')`;
   sai a asserção trivial de `exitCode`; a nova instância processa a redelivery sem
   duplicar.
4. Cenário 2: sessão externa segura o `FOR UPDATE`, o teste espera (por `pg_locks`)
   as duas apostas bloqueadas, depois libera.
5. Duplicata de evento: dois publicadores com lease expirado; um wrapper que
   registra as chamadas do cliente SQS real (sem mock) prova mesmo `eventId` e mesmo
   corpo nas duas publicações. Contrato do consumidor ("deduplica por `eventId`")
   documentado no `ARCHITECTURE.md`.
6. `Bun.sleep(5)` de `outbox-repository.test.ts:143` vira espera por condição; os
   `waitFor` duplicados viram um `test/support/wait-until.ts` compartilhado.
7. CI no GitHub Actions: typecheck, unit, integração e concorrência com o Compose,
   em push e PR; selo no README.

### 9. Ciclo `wallet ↔ wagering` e módulos que importam a raiz

**P:** `wagering → wallet` é inevitável (liquida na carteira). O ciclo fecha por
`wallet/application/create-wallet.ts` (cria a `OPENING`) e por
`wallet/infrastructure/wallet-ledger-entry.schema.ts` (relação da FK
`transaction_id`). `messaging`, `wagering` e `health` importam `config.ts`, contra
`ARCHITECTURE.md:66`. `health` implementa as portas de métricas dos outros módulos
sem que isso esteja documentado. Mover `CreateWallet` para `wagering` (a) ou
inverter com uma porta (b)?

**R:** (b), com o config e o health:
- `wallet/application` declara uma porta de registro da abertura (ex.:
  `OpeningRecorder`), implementada por `wagering` (cria a `OPENING` e enfileira os
  eventos) e ligada pela raiz de composição. `CreateWallet` e `POST /wallets` ficam
  em `wallet`.
- No schema do ledger, `transaction_id` vira coluna escalar, não relação do ORM; a
  FK continua na migration — a garantia no banco não muda.
- Cada módulo declara seu tipo de opções (`forRoot(options)`); `app.ts` traduz o
  `config`. Nenhum módulo importa a raiz.
- `health` documentado no `ARCHITECTURE.md` como o módulo mais externo, que adapta
  as portas de métricas dos demais; dependência sempre de `health` para fora.
- Direção resultante: `health` → `wagering` → `wallet` → `messaging`/`shared`, sem
  exceção.

### 10. Arestas da idempotência

**P:** O `settled` relê no `23505` da chave (replay ou conflito), mas devolve
`EXTERNAL_ID_CONFLICT` direto no `23505` do id externo — o replay de uma corrida
idêntica depende de o PostgreSQL checar o índice da chave primeiro. Na fila, mesmo
`messageId` + mesma chave + payload diferente responde `IDEMPOTENCY_CONFLICT`, não
`MESSAGE_ID_CONFLICT`. O hash do inbox inclui o `idempotencyKey` e o da transação
não. O replay de `PENDING_REFERENCE` devolve o estado atual (200), não o 202
original.

**R:** Os quatro:
1. O `23505` do id externo também relê por `(providerId, externalTransactionId)`:
   chave e hash iguais → replay; senão `EXTERNAL_ID_CONFLICT`.
2. Precedência mantida e documentada: o conflito de negócio (chave) vem antes do de
   transporte (`messageId`), porque diz ao provedor o que corrigir.
3. `ARCHITECTURE.md` diz que o hash do inbox cobre o `data` inteiro, chave incluída.
4. Interpretação reforçada no `ARCHITECTURE.md`: o replay de `PENDING_REFERENCE`
   devolve o desfecho atual — a regra 7 fala de operação "já processada", e repetir
   o 202 esconderia um desfecho que já existe.

### 11. Pontas da mensageria

**P:** `FAILED` não emite evento — quem submete pela fila não fica sabendo do
desfecho. O hand-back no `SIGTERM` (visibilidade 0) conta como recebimento e, com
reinícios seguidos, leva a mensagem à DLQ sem ela ter falhado. Não há heartbeat de
visibilidade.

**R:**
1. Evento novo **`WagerTransactionFailed`** (versão 1, `failureCode` e os dados de
   identificação do `Rejected`), enfileirado na outbox pela segunda unidade de
   trabalho que grava o `FAILED`. Além dos quatro mínimos do §11.
2. Limitação documentada: o hand-back no desligamento consome recebimento; o SQS
   não permite descontá-lo; com a decisão 1, a mensagem chega à DLQ sem desfecho e
   é reprocessável.
3. Limitação documentada, com os números: visibility timeout de 30 s
   (`WAGER_TRANSACTIONS_VISIBILITY_SECONDS`); com a decisão 6 (série por grupo,
   lote de 10, e o resto do grupo devolvido no primeiro retry), o pior caso de um
   lote é ~10 × `lock_timeout` de 2 s ≈ 20 s, abaixo dos 30 s. Se expirar mesmo
   assim, o inbox impede efeito duplicado.

### 12. Faxina de código e documentação

**P:** `spike/` segue no `tsconfig`, no `package.json` e no `CLAUDE.md`; a `Wallet`
não tem `assertSameCurrency` (§6.2) e depende do erro genérico do `Money.add`; há
contradições miúdas na documentação.

**R:** Os três:
1. Apagar `spike/`, os scripts `spike`/`spike:migrate`, a linha do `tsconfig` e os
   comandos do `CLAUDE.md`. O ADR 0001 passa a citar o commit em que o spike existia
   e os testes de concorrência que o substituem. Resolve o destino do `spike/` em
   aberto na #18.
2. `Wallet.assertSameCurrency` privado, chamado em `credit` e `debit` antes da conta,
   com teste unitário.
3. Documentação miúda, como comentário na #18: `README.md:9` × `:20`; "só domínio"
   no `test:unit` (README e `CLAUDE.md`); `docker-compose.yml:48` apontando para o
   `CLAUDE.md`; reescrever o trecho do ADR 0002 revogado pela emenda do publicador.

### 13. Teste de carga

**P:** O §14 cita `bun run test:load` como diferencial (ambiente, metodologia,
throughput, p50/p95/p99, taxa de erro, conflitos, outbox lag). Não existe.

**R:** Fazer, com três cenários:
- Runner em Bun (sem dependência nova) em `test/load/`, com 3 instâncias do app
  (reuso de `app-processes.ts`) e a fila real do Compose; duração e concorrência
  configuráveis.
- Cenários: (1) carteiras frias — N carteiras, mistura de BET/WIN/LOSS/REFUND por
  HTTP; (2) carteira quente — muitos clientes numa carteira (o lock pessimista);
  (3) fila — carga pelo SQS, medida de ponta a ponta até o evento publicado.
- Medidas: throughput, p50/p95/p99 do cliente, taxa de erro por status (503
  separado de 422), `lock_conflicts_total` e `outbox_lag_seconds` do `/metrics`
  durante a execução; ao fim, invariante do ledger e reconciliação de todas as
  carteiras.
- Resultado em `docs/load-test.md`: ambiente, metodologia, tabelas e análise
  honesta (limite da carteira quente, custo do LocalStack, o que não se conclui de
  um notebook Windows).
