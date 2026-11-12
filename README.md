# Distributed Wagering Processor

[![CI](https://github.com/PPrauchner/distributed-wagering-processor/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/PPrauchner/distributed-wagering-processor/actions/workflows/ci.yml?query=branch%3Amain)

Serviço que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`,
`ROLLBACK`) vindas de vários provedores, por HTTP e por SQS. Decisões, trade-offs,
interpretações do enunciado e limitações estão em
[`ARCHITECTURE.md`](ARCHITECTURE.md).

## Pré-requisitos

- [Bun](https://bun.sh) 1.x (testado com 1.4.4, a versão da imagem do app).
- Docker com o plugin Compose (`docker compose`).
- Portas livres no host: `3000` (app), `55432` (PostgreSQL) e `4566`
  (LocalStack).

Fora do Compose, o banco é acessado por `127.0.0.1`, nunca por `localhost`. No
Windows, `localhost` custa ~300 ms por conexão e esconde corridas nos testes.

## Subindo

```bash
bun install --frozen-lockfile
docker compose up -d --wait
```

O `--wait` só retorna quando tudo está pronto:

- **`postgres`**: PostgreSQL 17 em `127.0.0.1:55432` (usuário, senha e banco
  `wagering`).
- **`localstack`**: SQS emulado em `:4566`, já com `wager-transactions.fifo`,
  a DLQ dela (`wager-transactions-dlq.fifo`) e `wagering-events.fifo`. A imagem é
  fixada em `localstack/localstack:4.14.0`, a última que roda sem conta.
- **`migrate`**: roda as migrations uma vez e termina.
- **`app`**: a API em `http://127.0.0.1:3000`. Na mesma instância rodam também o
  consumidor da fila de entrada, o publicador da outbox e o worker de referências
  pendentes.

Depois de mudar o código, reconstrua a imagem do app:

```bash
docker compose up -d --wait --build
```

Para derrubar tudo e apagar os dados: `docker compose down -v`.

### Migrations à mão

As migrations rodam por script Bun, sem o CLI do MikroORM. Contra o banco do
Compose (padrão de `DATABASE_URL`):

```bash
bun run db:migrate up     # aplica as pendentes
bun run db:migrate down   # desfaz a última
```

### App fora do Compose

Com o PostgreSQL e o LocalStack do Compose de pé, pare o `app` do Compose para
liberar a porta e rode o processo direto:

```bash
docker compose stop app
bun src/main.ts
```

Os padrões apontam para o Compose: `PORT=3000`,
`DATABASE_URL=postgresql://wagering:wagering@127.0.0.1:55432/wagering` e
`SQS_ENDPOINT=http://127.0.0.1:4566`. O nível do log vem de `LOG_LEVEL` (padrão
`info`; um nível que o pino não conhece recusa a partida). As demais variáveis estão no
`ARCHITECTURE.md`, cada uma na seção do componente que configura.

## Usando a API

```bash
# Cria uma carteira com saldo inicial de 1000.00
curl -s -X POST http://127.0.0.1:3000/wallets \
  -H 'Content-Type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'

# Aposta 25.00 (troque <walletId> pelo `id` devolvido acima)
curl -s -X POST http://127.0.0.1:3000/wagering/transactions \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<walletId>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
```

Repetir a aposta com a mesma `Idempotency-Key` devolve o mesmo resultado, com
`idempotentReplay: true` e sem novo débito. Repetir a criação da carteira devolve
409 `WALLET_ALREADY_EXISTS` com o `walletId` existente: há uma carteira por
jogador e moeda.

```bash
# Confere o saldo da carteira contra o livro-razão (só leitura)
curl -s -X POST http://127.0.0.1:3000/wallets/<walletId>/reconciliation
```

A resposta traz `consistent`, o saldo guardado e o reconstruído, a diferença, os
buracos na sequência de versões (`versionGaps`) e as versões da carteira e do
último lançamento.

```bash
# Consultas
curl -s http://127.0.0.1:3000/wallets/<walletId>
curl -s 'http://127.0.0.1:3000/wallets/<walletId>/ledger?limit=50'
curl -s 'http://127.0.0.1:3000/wallets/<walletId>/ledger?limit=50&cursor=<nextCursor>'
curl -s http://127.0.0.1:3000/wagering/transactions/<transactionId>
curl -s http://127.0.0.1:3000/providers/provider-a/wagering/transactions/transaction-123
```

O livro-razão sai em ordem crescente; cada página traz `items` e `nextCursor`
(opaco; `null` na última página), que se passa em `cursor` para a próxima. O
`limit` vai de 1 a 200, com padrão 50. Os status HTTP e os códigos de falha
estão em [`ARCHITECTURE.md` § Status HTTP](ARCHITECTURE.md#status-http) e
[§ Códigos de falha](ARCHITECTURE.md#códigos-de-falha).

### Health e métricas

```bash
curl -s http://127.0.0.1:3000/health/live    # 200 enquanto o processo vive
curl -s http://127.0.0.1:3000/health/ready   # 200 com banco e filas alcançáveis; 503 senão
curl -s http://127.0.0.1:3000/metrics        # métricas no formato Prometheus
```

As métricas expostas (transações por tipo e desfecho, latência, conflitos de lock,
outbox lag, profundidade da DLQ, divergências de reconciliação) estão em
[`ARCHITECTURE.md` § Observabilidade](ARCHITECTURE.md#observabilidade).

## Várias instâncias

Sem nada além do comando, o Compose sobe uma instância do app em `:3000`. Para
subir três sobre o mesmo PostgreSQL e as mesmas filas, passe em `APP_PORTS` uma
faixa de portas do host, uma porta por réplica:

```bash
APP_PORTS=3000-3002 docker compose up -d --wait --scale app=3
```

Cada réplica fica numa porta da faixa, mas não necessariamente na ordem das
réplicas. Para descobrir qual está em qual porta, veja a coluna `PORTS` de
`docker compose ps app`. Cada uma responde em `http://127.0.0.1:<porta>/health/ready`.

`--scale app=3` sem `APP_PORTS` falha: as réplicas disputam a mesma porta `3000` do
host e só a primeira sobe. O HTTP não é balanceado, então quem chama só `:3000`
fala com uma réplica. A fila de entrada e a outbox, essas, são consumidas pelas
três.

## Enviando pela fila

A fila de entrada é `wager-transactions.fifo`. Cada mensagem leva o envelope do
§10 no corpo e, na chamada a `SendMessage`:

- `MessageGroupId` = `walletId`, a unidade de concorrência: as transações de uma
  carteira são processadas em série, na ordem de envio, e carteiras distintas em
  paralelo;
- `MessageDeduplicationId` = `messageId` do envelope.

Pelo `awslocal` de dentro do container do LocalStack (sem AWS CLI no host), a mesma
aposta do exemplo HTTP, agora pela fila:

```bash
docker compose exec localstack awslocal sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id <walletId> \
  --message-deduplication-id msg-123 \
  --message-body '{"messageId":"msg-123","type":"WagerTransactionRequested","occurredAt":"2026-07-29T15:00:00.000Z","data":{"providerId":"provider-a","externalTransactionId":"transaction-124","idempotencyKey":"provider-a:transaction-124","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<walletId>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}}'
```

Com o AWS CLI no host, o comando é o mesmo com `aws --endpoint-url
http://127.0.0.1:4566` no lugar de `awslocal` (credenciais quaisquer, região
`us-east-1`). Para reenviar à fila o que está na DLQ, ver
[`ARCHITECTURE.md` § Limitações conhecidas](ARCHITECTURE.md#limitações-conhecidas).

Os desfechos são publicados em `wagering-events.fifo` (`WagerTransactionProcessed`,
`WagerTransactionRejected`, `WagerTransactionPendingReference`,
`WagerTransactionFailed`, `WalletBalanceChanged`). Uma
submissão não admitida vai à DLQ com o atributo `failureCode`. Detalhes em
[`ARCHITECTURE.md` § Consumidor](ARCHITECTURE.md#consumidor).

## Testes

| Comando | O que roda | Precisa do Compose |
|---|---|---|
| `bun run typecheck` | `tsc --noEmit`, TypeScript estrito | não |
| `bun run test:unit` | domínio, aplicação e interface com fakes, sem I/O | não |
| `bun run test:integration` | app em processo contra o PostgreSQL e o LocalStack reais, sem mocks de banco ou fila | sim |
| `bun run test` | `test:unit` + `test:integration` (~3 min) | sim |
| `bun run test:concurrency` | os 8 cenários de concorrência do §13, com processos reais do app | sim |

A CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) roda as quatro
verificações — `typecheck`, `test:unit`, `test:integration` e `test:concurrency` —
em todo push e pull request, contra o Compose real; em falha, os logs dos processos
da concorrência e o `docker compose logs` ficam como artefato da execução.

Para a integração e a concorrência, basta o PostgreSQL e o LocalStack do Compose
(`docker compose up -d --wait`). O serviço `app` não é usado: a cada execução, o
banco `wagering_test` é recriado e migrado, e cada teste cria filas próprias com
sufixo aleatório.

Na integração, o log JSON do app fica em silêncio (`LOG_LEVEL=silent`, posto pelo
preload só quando a variável não vem definida), para que uma falha e o resumo do
bun apareçam nas últimas linhas da saída. Para depurar, religue-o:
`LOG_LEVEL=info bun run test:integration` (aceita os níveis do pino: `fatal`,
`error`, `warn`, `info`, `debug`, `trace`, `silent`).

### `bun run test:concurrency`

Não entra no `bun run test`: roda à mão e na CI. O app real roda em
processos separados (`Bun.spawn` de `src/main.ts`), com tempos curtos por variável
de ambiente. Toda espera é por condição com timeout, nunca por `sleep` fixo.

Os cenários:

1. a mesma aposta enviada 50 vezes em paralelo: um único débito;
2. duas apostas de `80.00` simultâneas sobre `100.00` (o cenário do §8);
3. carteiras distintas em paralelo, sem lock global;
4. 3 instâncias sobre o mesmo banco e filas, com carga por HTTP e pela fila;
5. worker morto (`SIGKILL`) depois do commit e antes do `ack`;
6. publicadores concorrentes sobre a mesma outbox, um deles morto depois do envio;
7. `REFUND` e `ROLLBACK` entregues antes da referência;
8. `SIGKILL` em todas as instâncias no meio da carga, nova subida e quiescência.

Todo cenário termina verificando, em cada carteira tocada, que o saldo guardado é
igual ao reconstruído pelo livro-razão e que as versões não têm buracos. Os logs de
cada processo ficam em `<tmp>/wagering-concurrency-logs/`.
