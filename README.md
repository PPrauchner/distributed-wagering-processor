# Distributed Wagering Processor

Serviço que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`,
`ROLLBACK`) vindas de vários provedores, por HTTP e por SQS. Decisões e trade-offs
em [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Várias instâncias

Sem nada além do comando, o Compose sobe uma instância do app em `:3000`:

```bash
docker compose up -d --wait
```

Para subir três instâncias sobre o mesmo PostgreSQL e as mesmas filas, passe uma
faixa de portas do host em `APP_PORTS`, uma porta por réplica:

```bash
APP_PORTS=3000-3002 docker compose up -d --wait --scale app=3
```

Cada réplica fica numa porta da faixa, mas não necessariamente na ordem das
réplicas. Para descobrir qual está em qual porta, veja a coluna `PORTS` de
`docker compose ps app`; cada uma responde em `http://127.0.0.1:<porta>/health/ready`.

`--scale app=3` sem `APP_PORTS` falha: as réplicas disputam a mesma porta `3000` do
host e só a primeira sobe. O HTTP não é balanceado — quem chama só `:3000` fala com
uma réplica; a fila de entrada e a outbox, essas, são consumidas pelas três.

## Testes

Todas as suítes rodam contra o PostgreSQL e o LocalStack reais, sem mocks de banco
ou fila. Antes, suba o Compose:

```bash
bun install --frozen-lockfile
docker compose up -d --wait
```

| Comando | O que roda |
|---|---|
| `bun run test` | unit + integration |
| `bun run test:unit` | só domínio, sem I/O |
| `bun run test:integration` | app em processo contra o banco e as filas reais |
| `bun run test:concurrency` | os 8 cenários de concorrência do §13, com processos reais do app |

### `bun run test:concurrency`

Roda à mão, antes da entrega — não entra no `bun run test`. Exige o PostgreSQL
(`127.0.0.1:55432`) e o LocalStack (`:4566`) do Compose de pé; o serviço `app` do
Compose não é usado. A cada execução, o banco `<db>_test` é recriado e migrado,
cada cenário cria filas próprias com sufixo aleatório, e o app real roda em
processos separados (`Bun.spawn` de `src/main.ts`), com tempos curtos por variável
de ambiente. Toda espera é por condição com timeout, nunca por `sleep` fixo.

Os cenários:

1. a mesma aposta enviada 50 vezes em paralelo — um único débito;
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
