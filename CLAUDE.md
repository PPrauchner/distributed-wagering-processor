# JungleGaming — Distributed Wagering Processor

Solução do desafio técnico da Jungle Gaming: um serviço financeiro distribuído que
processa transações de apostas (BET, WIN, LOSS, REFUND, ROLLBACK) vindas de vários
provedores de jogos, por HTTP e por SQS, mantendo-se correto com mensagens
duplicadas, fora de ordem e processadas em paralelo por várias instâncias.

O enunciado completo — requisitos, restrições invioláveis e critérios de avaliação —
está em `docs/Desafio.md`. Ele é a especificação: em dúvida, vale o que está lá.

## Stack (prescrita pelo enunciado)

- Bun 1.x (runtime, gerenciador de pacotes e test runner)
- TypeScript em modo estrito
- NestJS 12
- PostgreSQL, com migrations versionadas e reversíveis
- AWS SQS emulado por `localstack/localstack:4.14.0` (fixada: as versões posteriores
  exigem conta)
- Docker Compose para orquestração local
- ORM: MikroORM 7, mapeado com `defineEntity` fora do domínio — ver
  `docs/adr/0001-mikroorm-7-com-invariantes-no-schema.md`

## Comandos

```bash
bun install --frozen-lockfile   # dependências
docker compose up -d --wait     # PostgreSQL (127.0.0.1:55432), LocalStack (:4566)
                                # com as filas criadas, migrations (serviço
                                # migrate) e app (:3000)
docker compose up -d --wait --build   # idem, reconstruindo a imagem do app
bun run typecheck               # tsc --noEmit (TypeScript 6.0)
bun run test                    # unit + integration (exige o Compose de pé); ~3 min
                                # por execução — critério de "N execuções seguidas"
                                # custa ~3N min
bun run test:unit               # só domínio, sem I/O
bun run test:integration        # app em processo contra PostgreSQL e LocalStack reais; recria o
                                # banco <db>_test a cada execução
bun run test:concurrency        # os 8 cenários do §13, com processos reais do app;
                                # à mão, fora do `test` (exige o Compose de pé)
bun run db:migrate up|down      # migrations por script Bun, sem o CLI do MikroORM
bun src/main.ts                 # app local, fora do Compose (PORT, DATABASE_URL)
```

A conexão com o banco usa `127.0.0.1`, nunca `localhost` (ver ADR 0001). Os demais
comandos (`test:load`) entram aqui quando forem criados.

## Estrutura

`src/` é dividido em módulos — `shared`, `wallet`, `wagering`, `messaging`,
`health` —, cada um com as camadas `domain/` (regras puras, sem NestJS nem ORM),
`application/` (use cases e portas), `infrastructure/` (MikroORM, SQS, migrations)
e `interface/` (controllers HTTP e handlers da fila). A dependência aponta só para
dentro.

Fora dos módulos fica só a raiz de composição — `main.ts`, `app.ts`, `config.ts`,
`database/` (MikroORM, `UnitOfWork`, migrations, tradução de erros do banco) e
`http/` (filtro de erros) —, que importa os módulos e nunca é importada por eles.
Ver `ARCHITECTURE.md` § Organização do código.

Entregáveis exigidos na raiz: `README.md` (setup e comandos) e `ARCHITECTURE.md`
(decisões, trade-offs, limitações).

## Documentação do projeto

- `CONTEXT.md` — glossário do domínio (termos em pt-BR ↔ identificadores em inglês)
- `docs/adr/` — decisões de arquitetura e seus porquês
- `docs/grills_logs/` — registros das sessões de decisão

## Agent skills

### Issue tracker

Issues e PRDs ficam no GitHub Issues do repositório, via `gh`. See `docs/agents/issue-tracker.md`.

### Triage labels

Os cinco estados canônicos com os nomes padrão (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: um `CONTEXT.md` e `docs/adr/` na raiz. See `docs/agents/domain.md`.
