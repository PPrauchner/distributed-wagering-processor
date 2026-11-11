# Wagering

Processamento financeiro das transações de apostas que provedores de jogos enviam
para as carteiras dos jogadores, com saldo e histórico sempre corretos.

## Language

### Participantes

**Provedor** (`providerId`):
Fornecedor de jogos que envia transações de aposta. Quem chama a API é sempre um
provedor.
_Avoid_: fornecedor, parceiro, integrador, usuário

**Identidade do provedor** (`ProviderIdentity`):
O provedor como o qual uma requisição HTTP está autenticada. O `providerId` que a
requisição declara tem de ser o dela; a fila, canal interno, não tem identidade.
_Avoid_: usuário logado, sessão, credencial

**Jogador** (`playerId`):
A pessoa dona de carteiras, identificada pelo provedor.
_Avoid_: usuário, cliente

**Rodada** (`roundId`):
Uma partida de um jogo, à qual as transações de aposta se associam.
_Avoid_: partida, sessão, round

**Jogo** (`gameId`):
O título em que a rodada acontece.

### Carteira e livro-razão

**Carteira** (`Wallet`):
O saldo de um jogador numa moeda. Há no máximo uma carteira por jogador e moeda.
_Avoid_: conta, wallet (em texto pt-BR)

**Saldo** (`balance`):
O valor disponível guardado na carteira. Fica entre zero e o **saldo máximo**.
_Avoid_: saldo atual, crédito

**Saldo máximo**:
O maior saldo que uma carteira pode ter: `99999999999999999.99`, o limite da
coluna. Um crédito que o ultrapassaria é rejeitado (`BALANCE_LIMIT_EXCEEDED`),
nunca truncado.
_Avoid_: limite, teto (sozinhos)

**Valor** (`Money`):
Uma quantia exata numa moeda.
_Avoid_: quantia, montante, amount

**Lançamento** (`WalletLedgerEntry`):
Registro imutável de um débito ou crédito numa carteira, com o saldo antes e
depois. Só transações que movem o saldo geram lançamento.
_Avoid_: movimento, entrada

**Livro-razão** (`ledger`):
A sequência de lançamentos de uma carteira.
_Avoid_: extrato, histórico

**Abertura** (`OPENING`):
Transação de aposta interna que credita o saldo inicial de uma carteira; nunca vem
de um provedor.
_Avoid_: depósito, saldo inicial

**Saldo reconstruído** (`calculatedBalance`):
O saldo obtido a partir dos lançamentos do livro-razão.
_Avoid_: saldo calculado, saldo teórico

**Reconciliação** (`Reconciliation`):
A comparação entre o saldo de uma carteira e seu saldo reconstruído.
_Avoid_: auditoria, conciliação

**Divergência**:
Diferença não nula encontrada numa reconciliação; é sinalizada, nunca corrigida em
silêncio.
_Avoid_: erro de saldo, inconsistência

### Transações

**Transação de aposta** (`WagerTransaction`):
Uma operação financeira enviada por um provedor sobre uma rodada — `BET`, `WIN`,
`LOSS`, `REFUND` ou `ROLLBACK` —, ou a operação interna `OPENING`. No uso curto,
"transação" significa sempre esta.
_Avoid_: operação, movimentação, aposta (para qualquer tipo que não seja `BET`)

**Aposta** (`BET`):
A transação de aposta que debita o valor apostado da carteira. Só o `BET` é
"aposta".
_Avoid_: wager (para o `BET` isolado), jogada

**Ganho** (`WIN`):
Transação de aposta que credita o prêmio de uma rodada.
_Avoid_: prêmio, vitória

**Perda** (`LOSS`):
Transação de aposta que registra o resultado sem prêmio de uma rodada; não move o
saldo.
_Avoid_: derrota

**Aguardando referência** (`PENDING_REFERENCE`):
Situação da transação cuja referência ainda não chegou — uma transação dependente,
ou um ganho que cita sua aposta.
_Avoid_: órfã, pendente (sozinho)

**Reembolso** (`REFUND`):
Transação dependente que devolve à carteira o valor de uma aposta processada.
_Avoid_: estorno, devolução

**Reversão** (`ROLLBACK`):
Transação dependente que aplica o inverso de uma aposta, ganho ou reembolso
processado, desfazendo-o.
_Avoid_: estorno, cancelamento

**Transação dependente**:
Transação de aposta que exige uma referência — o reembolso e a reversão.
_Avoid_: transação de reversão, estorno

**Referência** (`referenceExternalTransactionId`):
A transação de aposta que outra cita: a que uma transação dependente desfaz, ou a
aposta da rodada que um ganho cita, opcionalmente. Uma referência só pode ser
desfeita uma vez, qualquer que seja o tipo da transação dependente; citá-la num
ganho não a desfaz.
_Avoid_: transação original, transação pai

### Identidade e idempotência

**Id da transação** (`transactionId`):
O identificador interno de uma transação de aposta, atribuído por nós.
_Avoid_: id (sozinho)

**Id externo** (`externalTransactionId`):
O identificador da transação de aposta no sistema do provedor; único por provedor.
_Avoid_: id do provedor, id original

**Chave de idempotência** (`idempotencyKey`):
O identificador da intenção de submeter uma transação de aposta; é a fonte da
verdade da deduplicação, qualquer que seja o canal de entrada. Protege contra o
reenvio.
_Avoid_: chave de deduplicação, id da requisição

**Id da mensagem** (`messageId`):
O identificador de uma entrega na fila. Protege contra a redelivery.
_Avoid_: id do evento, chave de idempotência

**Hash do payload** (`payloadHash`):
A impressão digital dos campos de negócio de uma transação de aposta, que distingue
replay de conflito de idempotência.
_Avoid_: checksum, assinatura

**Replay**:
Nova submissão com a mesma chave de idempotência e o mesmo hash do payload; recebe o
resultado original.
_Avoid_: duplicata, retry

**Conflito de idempotência**:
Nova submissão com a mesma chave de idempotência e hash do payload diferente; é
recusada, e não tratada como replay.
_Avoid_: duplicata, colisão

**Reenvio**:
O provedor submeter de novo a mesma transação de aposta, possivelmente por outro
canal ou envelope.
_Avoid_: duplicata

**Redelivery**:
A fila entregar de novo a mesma mensagem.
_Avoid_: duplicata, reenvio

### Desfechos

**Rejeição** (`REJECTED`):
Desfecho terminal de uma transação que viola uma regra de negócio. Reenviá-la igual
produz sempre a mesma rejeição.
_Avoid_: erro, recusa, falha

**Falha** (`FAILED`):
Desfecho terminal de uma transação que não pôde ser avaliada por um erro permanente
de infraestrutura. Não houve julgamento de negócio.
_Avoid_: rejeição, erro

**Submissão não admitida**:
Submissão de um provedor que nunca chegou a ser uma transação de aposta — payload
inválido, carteira inexistente, conflito de idempotência, id externo reusado com
outra chave. Fica registrada para auditoria, mas não tem desfecho nem
`transactionId`.
_Avoid_: rejeição, recusa, transação rejeitada

**Falha transitória**:
Indisponibilidade passageira que impede o processamento sem gerar desfecho; a
transação é tentada de novo. Esgotadas as tentativas, a submissão também termina
sem desfecho — nunca vira **Falha** — e pode ser reenviada com a mesma chave.
_Avoid_: falha (sozinho, neste sentido)

**Código de falha** (`failureCode`):
Identificador estável, legível por máquina, do motivo de uma rejeição ou falha.
_Avoid_: motivo, mensagem de erro

### Infraestrutura

**Transação SQL**:
A unidade atômica do banco de dados. Dito sempre por extenso, para não se confundir
com a transação de aposta.
_Avoid_: transação (sozinho, neste sentido)

**Inbox** (`InboxMessage`):
O registro das mensagens que um consumidor já recebeu.

**Outbox** (`OutboxMessage`):
Evento de integração gravado junto com a mudança que o originou, à espera de
publicação.
_Avoid_: fila de saída

**Evento de integração** (`IntegrationEvent`):
Fato publicado para fora do serviço depois que a mudança foi confirmada.
_Avoid_: notificação, mensagem
