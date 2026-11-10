---
status: accepted
---

# Lock pessimista por carteira, com tempo máximo de espera

A concorrência é controlada por **lock pessimista na linha da carteira**
(`SELECT … FOR UPDATE`, `LockMode.PESSIMISTIC_WRITE`), tomado como primeiro passo de
cada unidade de trabalho que move saldo. A carteira é a unidade de concorrência do
enunciado (§8); o lock é por linha, nunca global (§5.6). O lançamento precisa de
`balanceBefore` e `balanceAfter`, e o `Money` faz a conta no domínio — ler e depois
escrever é inevitável, e o lock é o que torna esse `read → calculate → update`
seguro (§5.7). O spike do ADR 0001 provou o mecanismo: duas apostas de 80.00 sobre
100.00, a segunda espera o commit da primeira e é recusada.

## Considered Options

- **Lock otimista por `version`, com retry limitado** — sugerido pelo enunciado. Numa
  carteira disputada (*hot wallet*), cada conflito vira retry, e os retries disputam
  de novo; a vazão cai justo onde a carga é maior.
- **`UPDATE … SET balance = balance - x WHERE id = ? AND balance >= x`** — atômico e
  sem espera, mas tira a aritmética do `Money` e do domínio, e o lançamento ainda
  precisaria do saldo anterior, devolvido por `RETURNING` — a regra financeira
  passaria a morar no SQL.

## Consequences

- **Tempo máximo de espera:** cada unidade de trabalho faz
  `SET LOCAL lock_timeout = '2s'`. Estourar é **erro transitório**: na fila, a
  mensagem volta com backoff; no HTTP, a resposta é 503 com `Retry-After`. Cada
  estouro conta como conflito de lock na métrica do §12. Sem o limite, uma carteira
  travada pendura conexões até esgotar o pool. O conversor de erros do MikroORM
  7.2.8 para PostgreSQL não mapeia o SQLSTATE `55P03` (o `LockWaitTimeoutException`
  nunca é produzido): o estouro chega como `DriverException` genérico e é
  reconhecido pelo código.
- **Sem deadlock por desenho — por uma regra de ordem:** *o lock da carteira é o
  primeiro lock de toda transação SQL que toca uma carteira*, antes de qualquer lock
  de linha em transação, lançamento, inbox ou outbox; e cada transação SQL trava uma
  única carteira (`REFUND` e `ROLLBACK` movem a carteira da referência, que é a
  mesma). Só "uma carteira por transação" não basta: um worker que segurasse a linha
  de uma transação pendente e depois esperasse a carteira entraria em deadlock com
  uma requisição que travou a carteira e tocasse a mesma linha.
- **Workers reivindicam com lease, numa transação SQL curta e separada**
  (`UPDATE … SET next_attempt_at = now() + lease WHERE id IN (SELECT … FOR UPDATE
  SKIP LOCKED LIMIT n) RETURNING id`, com commit), e processam cada item na sua
  própria unidade de trabalho, que começa pelo lock da carteira e relê o item para
  confirmar o estado. Se o worker morre, o lease expira e outra instância assume.
  Vale para o worker de referências pendentes e, por consistência, para o
  publicador da outbox (corrigido pela emenda abaixo).
- **A transação pendente só é resolvida pelo worker**, nunca na chegada da
  referência: resolver na hora seria seguro com a regra acima, mas é escopo extra; a
  latência fica limitada pelo intervalo do worker.
- Um deadlock (`40P01`), se ocorrer mesmo assim, é tratado como transitório.
- **`version` não é lock otimista:** sobe só quando o saldo muda (§6.2) e serve de
  contador monotônico, auditável na reconciliação. Não é mapeado como versão do ORM.
- A espera pelo lock serializa as transações de uma mesma carteira: a vazão de uma
  carteira isolada é limitada pela duração da transação, que por isso não faz I/O
  externo (a publicação de eventos sai pela outbox, depois do commit).

## Emenda — o publicador da outbox não trava a carteira

O trecho acima que diz que o publicador da outbox, "por consistência", processa
cada item numa unidade de trabalho que começa pelo lock da carteira não vale. O
publicador reivindica um lote por lease (`FOR UPDATE SKIP LOCKED` +
`next_attempt_at = now() + lease`, no relógio do banco) numa transação SQL curta
e, depois do envio ao SQS, grava `published_at` (ou reagenda) noutra transação
SQL curta. **Nenhuma das duas toca `wallets`**: ele não move saldo, não precisa
do lock e não o toma. A regra de ordem continua valendo — o lock da carteira é o
primeiro lock de toda transação SQL que toca uma carteira —, porque as transações
do publicador não tocam carteira nenhuma, e as transações que tocam a carteira
só inserem na outbox, sem travar linhas que o publicador segure. O worker de
referências pendentes segue como descrito acima: ele move saldo e começa pela
carteira.
