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

Ainda não há scaffold. Instalação de dependências: `bun install --frozen-lockfile`.
Os demais comandos (dev, testes de unidade/integração/concorrência, `test:load`,
migrations) entram aqui quando forem criados.

## Estrutura

`src/` é dividido em módulos — `shared`, `wallet`, `wagering`, `messaging`,
`health` —, cada um com as camadas `domain/` (regras puras, sem NestJS nem ORM),
`application/` (use cases e portas), `infrastructure/` (MikroORM, SQS, migrations)
e `interface/` (controllers HTTP e handlers da fila). A dependência aponta só para
dentro.

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
