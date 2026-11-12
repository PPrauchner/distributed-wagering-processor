---
status: accepted
---

# MikroORM 7, mapeado fora do domínio, com as invariantes no schema

Usamos **MikroORM 7** como ORM, com as entidades mapeadas por `defineEntity` na
camada de infraestrutura — o domínio não importa nada do ORM —, migrations
executadas programaticamente por um script Bun e entidades registradas
explicitamente. As garantias financeiras (unicidade, imutabilidade do livro-razão,
saldo não negativo) moram no schema do PostgreSQL, não no ORM.

MikroORM é o preferido do enunciado e oferece Unit of Work, Identity Map,
`em.transactional()` e lock pessimista, que casam com o desenho de travar a carteira
dentro de uma única transação SQL. A versão 7 desacoplou o core e os drivers do
Node e tornou `defineEntity` o caminho recomendado, o que reduz o atrito com Bun e
dispensa decorators no domínio.

## Spike (10/11/2026)

Aceito depois de um spike (Bun 1.4.4, NestJS 12.4, MikroORM 7.2.8, TypeScript 6.0,
PostgreSQL 17), com testes contra banco real, estáveis em execuções repetidas. O
spike foi removido do repositório depois de cumprir seu papel; o código dele está
no commit
[`001415f`](https://github.com/PPrauchner/distributed-wagering-processor/tree/001415f/spike).
Hoje os testes de concorrência (`test/concurrency/`, `bun run test:concurrency`)
provam o mesmo sobre o código real. O spike cobria:

- migrations de ida e volta pelo `migrator`, num script Bun, sem o CLI;
- classe de domínio com construtor privado, mapeada por `defineEntity`, hidratada
  como instância da classe e com o `numeric(19,2)` lido como string exata;
- `CHECK (balance >= 0)` barrando saldo negativo mesmo por SQL cru;
- duas transações SQL simultâneas debitando 80.00 de 100.00: sem lock há lost
  update (controle negativo); com `PESSIMISTIC_WRITE` a segunda espera o commit da
  primeira e é recusada, saldo final 20.00 — a linha do tempo das transações prova
  que a disputa foi real;
- injeção de dependência por tipo de construtor e rota HTTP do NestJS rodando sobre
  Bun.

## Considered Options

- **TypeORM 1.x** — aceito pelo enunciado, que porém prefere o MikroORM pelos
  recursos de que este desenho depende (Unit of Work, Identity Map,
  `transactional()`, `LockMode`). Sem Unit of Work nem Identity Map, a transação com
  lock teria de ser orquestrada à mão.
- **MikroORM 6** — ainda construído sobre o Knex, cujo acoplamento ao Node é o
  atrito que a versão 7 removeu ao trocá-lo pelo Kysely.
- **Registros de persistência separados + mapper** — ver o desvio do §6.0 em
  Consequences.

## Consequences

- O CLI do MikroORM ainda exige Node; não o usamos — migrations rodam pelo
  `migrator` a partir de um script Bun, com a lista de migrations explícita.
- **Toda unidade de trabalho é aberta pelo use case**, por uma porta `UnitOfWork`
  em `application/`; a implementação, na infraestrutura, faz
  `em.fork().transactional()` e entrega repositórios presos à transação. Vale igual
  para HTTP, consumidor da fila e workers — o §10 exige o mesmo use case nas
  entradas —, e cada execução tem seu próprio Identity Map. O request context do
  NestJS fica ligado só como rede de segurança: fora dele, o `EntityManager` global
  lança erro em vez de compartilhar estado. Injetar o `EntityManager` no use case
  seria mais simples, mas faria `application/` depender do ORM.
- O tipo `EntityCtor` do `defineEntity` exige construtor público. Como o domínio usa
  construtor privado + factories, o arquivo de mapeamento faz uma coerção de tipo
  da classe (`as unknown as EntityCtor<T>`), confinada à infraestrutura.
- **O construtor privado só atribui parâmetros.** A hidratação não o chama, mas a
  descoberta de metadados chama `new Classe()` sem argumentos, duas vezes por
  propriedade, sem opção para desligar, e engole exceções; um inicializador de campo
  vira valor padrão da propriedade. Por isso: sem validação, sem efeito colateral e
  sem inicializador de campo no construtor — validação e valores iniciais moram nas
  factories (`open`, `create`).
- **Desvio deliberado do §6.0 do enunciado.** As classes de domínio são as próprias
  entidades do ORM, e o MikroORM as hidrata por `Object.create`, sem passar pela
  factory `rehydrate`. A garantia que o §6.0 protege se mantém: reidratar reconstrói
  o estado persistido sem revalidar transições. A alternativa — registros de
  persistência separados e um mapper que chama `rehydrate` — cumpriria a letra, mas
  trocaria o Unit of Work e o Identity Map, motivo da escolha do MikroORM, por
  cópia manual de estado em cada repositório. O `rehydrate` continua existindo para
  reconstruir estado fora do ORM (testes, leituras por SQL cru), e o desvio é
  declarado no `ARCHITECTURE.md`.
- **`Money` é um embeddable**: cada valor ocupa duas colunas,
  `<prefixo>_amount numeric(19,2)` e `<prefixo>_currency`. Por isso o estado interno
  do `Money` é o que vai à coluna — `_amount` como string decimal exata, não um
  objeto `Decimal` —, e a aritmética converte para centavos em `bigint`. A moeda
  repetida (três vezes no lançamento) é amarrada no schema: um `CHECK` exige que
  sejam iguais, e uma FK composta `(wallet_id, currency) → wallets(id, currency)`
  exige que a moeda do lançamento seja a da carteira. A carteira repete a moeda do
  mesmo jeito (`currency` e `balance_currency`), e um `CHECK` as amarra; a FK
  composta aponta para `currency`. A FK de moeda fica só no lançamento: a transação
  de aposta precisa poder chegar com outra moeda para ser persistida como `REJECTED`
  (`CURRENCY_MISMATCH`). A alternativa — valor e moeda
  em colunas soltas, com o `Money` montado no getter — faria o domínio guardar
  primitivos por causa do ORM.
- Estado do domínio usa campos `private` do TypeScript, não `#private` do
  JavaScript: o ORM precisa ler e escrever essas propriedades.
- **Campo privado mapeado aponta para o seu getter** com `.accessor('<getter>')`
  (`_status: p.string().accessor('status')`). Sem isso, o nome `_status` não aparece
  nos tipos de consulta e o getter não é propriedade mapeada; com isso, filtros usam
  o nome público, com tipo, e a coluna herda o nome do getter. Limitação conhecida:
  `orderBy` pelo nome do getter falha em runtime (MikroORM 7.2.8) — ordenação por
  estado privado, se inevitável, fica no repositório com coerção comentada.
- Consultas de fila (reivindicar eventos da outbox, transações aguardando
  referência) são SQL explícito no repositório, com `FOR UPDATE SKIP LOCKED`, para
  que publishers e workers concorrentes não peguem a mesma linha. A reivindicação é
  um lease numa transação SQL curta e separada — ver o ADR 0002.
- TypeScript fixado em 6.0. Aqui ele só checa tipos (`noEmit`): os metadados de
  decorators que o NestJS usa em runtime vêm do transpilador do Bun. O 7.0 nativo é
  uma reescrita recente, e trocar de verificador perto da entrega arrisca diferenças
  de checagem (decorators experimentais, tipos do MikroORM) sem ganho; a fixação é
  reversível a qualquer momento.
- A conexão com o banco usa `127.0.0.1`, não `localhost`: no Windows o `localhost`
  tenta IPv6 primeiro e cada conexão nova leva ~300 ms, o que serializa transações
  por acaso e faz um teste de concorrência passar sem disputa real.
- **Um único classificador de erros do banco**, na infraestrutura, lê o SQLSTATE e o
  nome da constraint e devolve a categoria do §10: `40001`, `40P01`, `55P03` e queda
  de conexão são transitórios. O `23505` segue um critério: unicidade cuja disputa
  escapa do lock da carteira é desfecho legítimo — carteira por jogador e moeda e
  id externo por provedor são conflito, chave de idempotência é replay ou conflito
  (relê e compara o hash), inbox é redelivery (`ack` sem efeito); unicidade
  serializada pelo lock — uma reversão por referência, um lançamento por transação
  e carteira — é bug, permanente. Violação de `CHECK` de saldo ou de moeda, FK de
  moeda ou trigger do livro-razão é permanente (`FAILED`, com alerta). `REJECTED`
  vem só do domínio, que verifica saldo e moeda antes, sob lock — se o schema
  dispara, o domínio deixou passar, e isso é bug, não regra de negócio. Cada caso
  tem teste de integração pelo caminho do flush.
- Como as invariantes estão no schema e o domínio é puro, trocar de ORM afeta só a
  camada de persistência.
