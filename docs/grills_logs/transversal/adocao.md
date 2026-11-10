# Grill da adoção do repositório

Data: 2026-11-10. Repositório greenfield; a especificação é `docs/Desafio.md`.

## Decisões de setup

- Versionamento: `git init` local; remoto no GitHub a ser criado pelo autor.
- Issues no GitHub Issues; rótulos de triagem com os nomes padrão
  (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`).
- Documentação de domínio em contexto único: `CONTEXT.md` e `docs/adr/` na raiz.
- Comando de testes: nenhum por enquanto — ainda não há scaffold nem testes; será
  definido quando existir suíte.
- Comando de setup: `bun install --frozen-lockfile`.

## Perguntas e respostas

### 1. O que "transação" significa?

**Pergunta:** o enunciado usa "transação" para a operação do provedor
(`WagerTransaction`) e para a transação do banco. Qual termo para cada uma?

**Resposta:** `WagerTransaction` é a **transação de aposta** (no uso curto,
"transação"); o lado do banco é sempre dito **transação SQL**. **Aposta** é só o
`BET`. Evitar "operação" e "movimentação" como sinônimos.

### 2. Fronteira entre `REFUND` e `ROLLBACK`

**Pergunta:** os dois desfazem algo. Como chamá-los e se um mesmo `BET` pode
receber os dois.

**Resposta:**

- **Reembolso** = `REFUND` (só de `BET`, sempre crédito); **reversão** =
  `ROLLBACK` (de `BET`, `WIN` ou `REFUND`, aplica o inverso). "Estorno" é proibido
  por ser ambíguo.
- O guarda-chuva dos dois é **transação dependente** (exige referência); a
  transação apontada é a **referência**.
- **Interpretação adicional, a documentar no `ARCHITECTURE.md`:** uma referência
  só pode ser desfeita **uma vez, por qualquer tipo**. `REFUND` e `ROLLBACK` do
  mesmo `BET` são mutuamente exclusivos — o segundo é rejeitado. O enunciado
  ("não pode ser revertida duas vezes pelo mesmo tipo") permitiria devolver o valor
  da aposta duas vezes; desfazer um reembolso indevido se faz com a reversão *do
  reembolso*, não com um segundo desfazer da aposta.

### 3. Organização dos logs de grill

**Pergunta:** criar `docs/grills_logs/README.md` com regras de organização?

**Resposta:** sim, só com regras: uma pasta por unidade do projeto, criada com o
primeiro grill dela, mais `transversal/`. Sem pasta `negocio/` — é um desafio
técnico, sem clientes nem propostas. Este log fica em `transversal/`.

### 4. Fronteira entre `REJECTED` e `FAILED`

**Pergunta:** os dois são terminais e têm `failureCode`. Onde fica a fronteira?

**Resposta:**

- **Rejeição** (`REJECTED`): violação de regra de negócio; reenviar igual dá sempre
  o mesmo resultado.
- **Falha** (`FAILED`): erro permanente de infraestrutura, sem julgamento de negócio
  (ex.: mensagem que esgotou as tentativas e foi para a DLQ).
- **Falha transitória** não é estado: não persiste desfecho, vira retry (ou HTTP de
  indisponibilidade) e a transação segue sem existir ou em `PENDING`.
- **Código de falha** é o nome do campo nos dois terminais. A taxonomia dos códigos
  (ex.: `INSUFFICIENT_FUNDS` ≠ `REVERSAL_INSUFFICIENT_FUNDS`, `REFERENCE_NOT_FOUND`,
  `REFERENCE_ALREADY_REVERSED`, `CURRENCY_MISMATCH`, `INFRA_*`) fica no
  `ARCHITECTURE.md`, não no glossário.

### 5. Os identificadores e as camadas de deduplicação

**Pergunta:** qual a fronteira entre `transactionId`, `externalTransactionId`,
`idempotencyKey` e `messageId`?

**Resposta:**

| Termo | Identificador | O que identifica | Origem |
|---|---|---|---|
| id da transação | `transactionId` | a transação, internamente | nossa (UUIDv7) |
| id externo | `externalTransactionId` | a transação no provedor; único por `(providerId, externalTransactionId)` | provedor |
| chave de idempotência | `idempotencyKey` | a intenção de submeter; fonte da verdade da deduplicação | provedor |
| id da mensagem | `messageId` | uma entrega na fila; deduplica no inbox por `(consumerName, messageId)` | transporte |

- O **inbox** protege contra **redelivery** da fila; a **chave de idempotência**
  protege contra **reenvio** do provedor. Duas mensagens com `messageId` diferentes
  e a mesma chave passam pelo inbox, e é a chave que impede o efeito duplo.
- **Replay** = mesma chave e mesmo hash do payload (resposta original);
  **conflito de idempotência** = mesma chave, hash diferente (recusado).
- "Duplicata" sem qualificar é evitado.

### 6. Carteira, saldo, livro-razão e reconciliação

**Pergunta:** os termos do núcleo financeiro, e "extrato" × "livro-razão".

**Resposta:** carteira (`Wallet`), saldo (`balance`), valor (`Money`), lançamento
(`WalletLedgerEntry`), livro-razão (`ledger`), abertura (`OPENING`), saldo
reconstruído (`calculatedBalance`), reconciliação e divergência. **"Extrato" é
banido**: o livro-razão só contém o que moveu saldo (um `LOSS` não aparece nele),
enquanto "extrato" sugere a visão completa do jogador.

### 7. Participantes, tipos restantes e mensageria

**Pergunta:** termos para provedor, jogador, rodada, jogo, `WIN`, `LOSS`,
`PENDING_REFERENCE`, inbox, outbox e evento de integração.

**Resposta:** provedor, jogador, rodada, jogo, ganho (`WIN`), perda (`LOSS`),
aguardando referência (`PENDING_REFERENCE`), inbox, outbox e evento de integração.
"Jogador" e nunca "usuário": quem chama a API é o provedor, não o jogador. Inbox e
outbox ficam em inglês por serem nomes de padrão.

### 8. Qual ORM

**Pergunta:** MikroORM ou TypeORM? O autor pediu pesquisa antes de decidir, para não
ter de reverter depois.

**O que a pesquisa mostrou (nov/2026):** MikroORM está na 7.2 — trocou Knex por
Kysely, desacoplou core e drivers do Node e tornou `defineEntity` o mapeamento
recomendado; `@mikro-orm/nestjs` 7.1 suporta NestJS 11 e 12. Riscos restantes com
Bun: o CLI do MikroORM ainda exige Node, o glob nativo do Bun falha na descoberta de
entidades e, fora de HTTP, o Identity Map precisa de `em.fork()` por unidade de
trabalho. TypeORM chegou à 1.0 (mai/2026), sem Unit of Work e com quebras recentes.

**Resposta:** MikroORM 7, com `defineEntity` na infraestrutura (domínio puro),
migrations programáticas por script Bun, entidades registradas explicitamente e as
invariantes no schema do PostgreSQL. Registrado no ADR 0001 como **proposto**, a
virar aceito depois de um spike (Bun + NestJS 12 + MikroORM 7 + PostgreSQL, com
migration de ida e volta, `PESSIMISTIC_WRITE` e um teste em `bun test`).

**Achado:** o Bun não está instalado na máquina do autor.

### 9. Prazo e autenticação

**Pergunta:** qual o prazo da entrega, e implementar autenticação?

**Resposta:**

- **Prazo: quinta-feira, 12/11/2026, às 17h.**
- **Autenticação fica de fora** (vale zero pontos): ponto de extensão explícito no
  código — guard no-op atrás de uma porta que resolve a identidade do provedor — e o
  desenho com Keycloak descrito no `ARCHITECTURE.md`. Só entra se sobrar tempo.
- **Prioridade sobre diferenciais:** sobrando tempo, refatorar e endurecer o que
  vale pontos vem antes de implementar funcionalidade opcional "para enfeitar".

### 10. LocalStack ou MiniStack

**Pergunta:** qual emulador de SQS? O autor pediu para verificar antes qual tag do
LocalStack ainda roda sem conta.

**O que a verificação mostrou:** desde a `2026.03.0` o LocalStack exige token; o
repositório foi arquivado em 23/03/2026. A `4.14.0` (26/02/2026) é a última antes
disso e foi **testada nesta máquina**: subiu sem token, SQS disponível, fila FIFO com
redrive para DLQ FIFO criada, mensagem enviada com group id e deduplication id e
recebida. O MiniStack (1.5.39) é ativo e sem conta, mas não foi testado e é menos
conhecido.

**Resposta:** **LocalStack `4.14.0`, fixada.** Imagem congelada é aceitável no prazo
do desafio. Não vira ADR: trocar pelo MiniStack é mudar uma linha do Compose (mesmo
endpoint `:4566`); fica como nota no `ARCHITECTURE.md`.

### 11. Estrutura, camadas e quando quebrar uma mudança

**Pergunta:** como organizar `src/` e quando uma mudança é grande demais.

**Resposta:** módulos `shared`, `wallet`, `wagering`, `messaging` e `health`, cada um
com as camadas `domain`, `application`, `infrastructure` e `interface`, dependência
apontando só para dentro. Mudança que toca mais de 2 módulos, ou atravessa as 4
camadas de um e mexe em outro, vira plano de sub-tarefas — exceto o use case de
processar uma transação, que é uma fatia vertical única e se quebra por tipo
(`BET` → `WIN`/`LOSS` → `REFUND`/`ROLLBACK` com referência pendente).

## Como ficou decidido

### Restrições do projeto

- `docs/Desafio.md` é a especificação; as restrições invioláveis da seção 5 valem
  acima de qualquer conveniência.
- Prazo: quinta-feira, 12/11/2026, 17h. Sobrando tempo, refatorar e endurecer o que
  vale pontos vem antes de diferenciais opcionais.
- Stack fixa: Bun 1.x, TypeScript estrito, NestJS 12, PostgreSQL, SQS, Docker
  Compose.
- ORM: MikroORM 7 com `defineEntity` na infraestrutura; domínio sem ORM nem NestJS;
  migrations programáticas por script Bun; entidades registradas explicitamente;
  `em.fork()` por unidade de trabalho fora de HTTP. ADR 0001, proposto até o spike.
- Unicidade, imutabilidade do livro-razão e saldo não negativo garantidos no schema
  do PostgreSQL.
- SQS emulado por `localstack/localstack:4.14.0` fixada; nunca `latest` nem
  `2026.*`. Saída: MiniStack.
- Autenticação fora do escopo: guard no-op atrás de uma porta de identidade do
  provedor; desenho com Keycloak só documentado.
- Documentação em pt-BR; identificadores em inglês, conforme `CONTEXT.md`.
- Comando de testes: nenhum por enquanto. Comando de setup:
  `bun install --frozen-lockfile`.

### Calibragem de trabalho

- **Quebra:** a unidade é o módulo de `src/`; mais de 2 módulos, ou as 4 camadas de
  um mais outro, vira plano de sub-tarefas. Exceção: processar transação é uma
  fatia vertical, quebrada por tipo de transação.
- **Camadas:** `domain/`, `application/`, `infrastructure/`, `interface/` em cada
  módulo; um commit não mistura camadas de módulos diferentes sem necessidade.
