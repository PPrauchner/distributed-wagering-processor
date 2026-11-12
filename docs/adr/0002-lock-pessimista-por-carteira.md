---
status: accepted
---

# Lock pessimista por carteira, com tempo máximo de espera

A concorrência é controlada por **lock pessimista na linha da carteira**
(`SELECT … FOR UPDATE`, `LockMode.PESSIMISTIC_WRITE`), tomado como primeiro passo de
cada unidade de trabalho que toca a carteira — move saldo ou insere uma linha com FK
para ela (ver a emenda ao fim). As unidades do worker que não tocam carteira travam
só a linha da transação de aposta. A carteira é a unidade de concorrência do
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
- **`SELECT … FOR NO KEY UPDATE`** — o lock que o próprio PostgreSQL toma num
  `UPDATE` que não muda chave; não conflita com o `FOR KEY SHARE` que a checagem de
  FK toma na carteira ao inserir uma linha que a referencia, e assim eliminaria por
  construção o deadlock descrito na emenda sobre o `FAILED`. Descartado: o MikroORM
  não tem `LockMode` para ele (exigiria SQL cru justo no ponto em que o ORM foi
  escolhido pelo `LockMode` explícito, §4), e a regra de ordem abaixo resolve o
  mesmo caso sem exceção.

## Consequences

- **Tempo máximo de espera:** a transação SQL que trava a carteira faz
  `SET LOCAL lock_timeout = '2s'` antes do lock. Estourar é **erro transitório**: na fila, a
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
  Vale para o worker de referências pendentes, que move saldo.
- **O publicador da outbox não trava a carteira.** Ele reivindica um lote pelo
  mesmo lease (`FOR UPDATE SKIP LOCKED` + `next_attempt_at = now() + lease`, no
  relógio do banco) numa transação SQL curta e, depois do envio ao SQS, grava
  `published_at` (ou reagenda) noutra transação SQL curta. Nenhuma das duas toca
  `wallets`: ele não move saldo, não precisa do lock e não o toma. A regra de
  ordem continua valendo, porque as transações do publicador não tocam carteira
  nenhuma, e as que tocam a carteira só inserem na outbox, sem travar linhas que o
  publicador segure.
- **A transação pendente só é resolvida pelo worker**, nunca na chegada da
  referência: resolver na hora seria seguro com a regra acima, mas é escopo extra; a
  latência fica limitada pelo intervalo do worker.
- Um deadlock (`40P01`), se ocorrer mesmo assim, é tratado como transitório.
- **`version` não é lock otimista:** sobe só quando o saldo muda (§6.2) e serve de
  contador monotônico, auditável na reconciliação. Não é mapeado como versão do ORM.
- A espera pelo lock serializa as transações de uma mesma carteira: a vazão de uma
  carteira isolada é limitada pela duração da transação, que por isso não faz I/O
  externo (a publicação de eventos sai pela outbox, depois do commit).

## Emenda — inserir uma linha que referencia a carteira também é tocá-la

A gravação de `FAILED` (segunda unidade de trabalho, depois do rollback de um erro
permanente) não move saldo e por isso não travava a carteira. Mas inserir a
transação de aposta dispara a checagem da FK `wallet_id`, que toma `FOR KEY SHARE`
na linha da carteira — e esse lock conflita com o `FOR UPDATE`. Com duas
submissões da mesma chave, uma gravando `FAILED` (segura a entrada do índice da
chave, espera a carteira) e outra no caminho normal (segura a carteira, espera a
entrada do índice), o resultado era um deadlock (`40P01`). Sem efeito duplicado —
o `40P01` é transitório —, mas contrário à regra de ordem.

Correção: **"tocar uma carteira" inclui inserir uma linha com FK para ela.** A
gravação de `FAILED` começa pelo lock da carteira, como qualquer outra unidade de
trabalho que a toca. A regra de ordem volta a valer sem exceção.
