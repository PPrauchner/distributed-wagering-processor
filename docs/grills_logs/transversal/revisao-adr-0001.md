# Grill da revisão do ADR 0001

Início: 2026-11-10 10:51. Decide os achados da revisão independente do ADR 0001
(MikroORM 7) e do spike que o sustenta.

## Perguntas e respostas

### 1. `rehydrate` × hidratação do ORM (achado 1)

**P:** O §6.0 do enunciado exige reidratar pela factory `rehydrate`, mas o MikroORM
hidrata a classe de domínio por `Object.create`, sem passar por ela. Mapeamento
direto com o desvio registrado (a) ou registros de persistência + mapper que chama
`rehydrate` (b)?

**R:** (a) — mapeamento direto, com o desvio registrado no ADR 0001 e no
`ARCHITECTURE.md`. A hidratação do ORM cumpre a intenção do §6.0 (reconstrói o
estado persistido sem revalidar transições); o `rehydrate` continua existindo para
reconstrução fora do ORM.

### 2. Mapeamento do `Money` (achado 2)

**P:** `Money` como embeddable (duas colunas por valor; estado interno `_amount`
como string decimal exata, aritmética em centavos `bigint`), com a moeda repetida
do lançamento amarrada por `CHECK` e FK composta `(wallet_id, currency)`; ou valor e
moeda em colunas soltas, com o `Money` montado no getter?

**R:** Embeddable, com a moeda repetida amarrada no schema.

### 2b. Quando criar o `ARCHITECTURE.md`

**P:** O `ARCHITECTURE.md` (entregável obrigatório) nasce só na entrega ou agora,
como esqueleto com as seções que o enunciado cobra, crescendo a cada decisão?

**R:** Esqueleto criado ao fim desta sessão, já com o que ela decidir; cresce a cada
decisão nova.

### 3. O construtor do domínio roda no boot (achado 3)

**P:** A descoberta de metadados do MikroORM chama `new meta.class()` sem argumentos,
2× por propriedade, sem opção para desligar, e engole exceções; inicializadores de
campo viram valor padrão da propriedade. Regra de modelagem ou teste de guarda?

**R:** Regra registrada no ADR: o construtor privado só atribui parâmetros — sem
validação, sem efeito colateral, sem inicializador de campo. Validação e valores
iniciais moram nas factories.

### 4. Onde nasce a unidade de trabalho (achado 4)

**P:** O ADR separa HTTP (request context) de fora de HTTP (`em.fork()`), mas o §10
exige o mesmo use case nas duas entradas, e a fronteira da transação é do use case,
que não importa ORM. Porta `UnitOfWork` na aplicação ou `EntityManager` injetado no
use case?

**R:** Porta `UnitOfWork` em `application/`, implementada na infraestrutura com
`em.fork().transactional()` e repositórios presos ao `tx`; o use case abre a própria
unidade de trabalho em qualquer entrada. O request context do Nest fica ligado só
como rede de segurança (fora dele, o `EntityManager` global lança erro).

### 5. Estratégia de lock (achado 5)

**P:** Lock pessimista por carteira em vez de otimista ou `UPDATE` condicional;
`SET LOCAL lock_timeout = '2s'` com estouro como erro transitório (fila: backoff;
HTTP: 503 com `Retry-After`) e contado como conflito de lock; uma carteira travada
por transação, como primeiro passo, e deadlock tratado como transitório; `version`
como contador monotônico, não lock otimista. Fecha e vira ADR 0002?

**R:** Fecha as quatro como propostas e registra no ADR 0002
(`docs/adr/0002-lock-pessimista-por-carteira.md`).

### 6. Motivo da fixação do TypeScript 6.0 (achado 6)

**P:** O ADR atribui a fixação aos metadados de decorators, mas o `tsc` só checa
tipos (`noEmit`) e os metadados de runtime vêm do transpilador do Bun. Manter a
fixação e corrigir o motivo?

**R:** Sim: fixação mantida; o motivo passa a ser evitar trocar de verificador de
tipos perto da entrega, sem ganho.

### 7. "Considered Options" (achado 7)

**P:** Reescrever as alternativas descartadas: TypeORM pela preferência do enunciado
e pela falta de Unit of Work/Identity Map (sem as alegações sem fonte); MikroORM 6
pelo Knex (sem o `ts-node`, já que o CLI não é usado); registros + mapper remetendo
à Consequence do desvio do §6.0?

**R:** Sim, fechado assim.

### 8. Consultar por campo privado (achado 8)

**P:** Filtrar pelo nome mapeado (`_balance`) não compila e pelo getter falha em
runtime. Primeira proposta: SQL explícito nas consultas de fila e um helper de
coerção no repositório para as demais.

**R (contestação):** "Essa é realmente a melhor opção para esse projeto?" — levou a
investigar a opção `accessor` do MikroORM. Testada com getter sem setter: filtro pelo
nome público compila e funciona em runtime, o flush persiste, a coluna herda o nome
do getter; só `orderBy` pelo getter falha em runtime.

**R (final):** Todo campo privado mapeado usa `.accessor('<getter>')`; ordenação por
estado privado, se inevitável, fica no repositório com coerção comentada (limitação
registrada); consultas de fila seguem em SQL explícito com `FOR UPDATE SKIP LOCKED`,
por concorrência. O spike não muda; a convenção vale para `src/`.

### 9. Erros do banco → categoria de falha (achado 9)

**P:** Achado lateral: o conversor do MikroORM para PostgreSQL não mapeia `55P03`
(estouro do `lock_timeout`). Proposta: um classificador único na infraestrutura,
por SQLSTATE e nome da constraint — `40001`/`40P01`/`55P03`/conexão transitórios;
`23505` de idempotência/inbox como duplicata; `CHECK` de saldo, FK de moeda e trigger
do livro-razão como permanente (`FAILED`, com alerta), porque o domínio verifica
antes, sob lock, e só ele gera `REJECTED`. Um teste de integração por caso, pelo
flush.

**R:** Fechado. O detalhe do `55P03` entra no ADR 0002.

## Como ficou decidido

- ADR 0001 revisado: desvio do §6.0 declarado, `Money` como embeddable com a moeda
  amarrada no schema, regra do construtor, porta `UnitOfWork`, `accessor` nos campos
  privados, consultas de fila com `SKIP LOCKED`, classificador de erros do banco,
  motivo correto da fixação do TypeScript, alternativas reescritas.
- ADR 0002 criado: lock pessimista por carteira, `lock_timeout` de 2 s, uma carteira
  por transação, `version` como contador.
- `ARCHITECTURE.md` criado como esqueleto, com as decisões desta sessão.
