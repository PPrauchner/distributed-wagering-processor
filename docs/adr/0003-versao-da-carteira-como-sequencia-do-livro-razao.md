---
status: accepted
---

# A versão da carteira é a sequência do livro-razão

Cada lançamento guarda `wallet_version`, a versão da carteira **depois** dele, com
`UNIQUE (wallet_id, wallet_version)`. Como só lançamentos mudam o saldo e a
`version` sobe só quando o saldo muda (§6.2), os lançamentos de uma carteira formam
uma sequência contínua — 1, 2, 3… —, ordenada pelo lock pessimista da carteira
(ADR 0002), não por relógio. Um *constraint trigger* `DEFERRABLE INITIALLY
DEFERRED` em `wallets` amarra os dois lados no commit: toda mudança de saldo exige
um lançamento com `balance_before = OLD.balance`, `balance_after = NEW.balance` e
`wallet_version = NEW.version`, e a versão sobe exatamente 1 quando o saldo muda e
fica igual quando não muda. Assim "toda alteração de saldo tem lançamento" (§6.2)
vale no schema (§5.9), não só no código.

A sequência serve três vezes: é o cursor da paginação do livro-razão
(`base64url("v1:<walletId>:<wallet_version>")`, ordem crescente — páginas já
servidas nunca mudam); é o que a reconciliação usa para achar lançamento faltando
(buraco na sequência), além da diferença de valor; e é o `walletVersion` dos
eventos `WalletBalanceChanged`, pelo qual o consumidor ordena o que a outbox não
ordena.

## Considered Options

- **Paginar pelo `id` UUIDv7 ou por `created_at`** — ambos vêm do relógio da
  instância que gerou o lançamento. Com relógios dessincronizados entre instâncias,
  um lançamento posterior pode receber id ou data menor e aparecer numa página já
  lida: o cursor deixa de ser estável.
- **Sequência global (`bigserial`)** — monotônica na alocação, mas não na ordem de
  commit: uma transação SQL que alocou antes pode confirmar depois, e o mesmo
  problema volta. Também não detecta lançamento faltando por carteira.
- **"Saldo ↔ lançamento" só no código** — o domínio já garante, mas um `UPDATE` cru
  em `wallets` passaria sem deixar rastro no livro-razão.

## Consequences

- Carteira aberta com saldo zero não tem abertura: nasce com `version` 1 e o
  primeiro lançamento tem versão 2. A sequência começa em 1 com abertura e em 2
  sem ela; `checkedEntries` da reconciliação segue a mesma regra.
- `version` continua não sendo lock otimista (ADR 0002): é contador e sequência.
- Violação do trigger é permanente no classificador de erros do banco
  (`INFRA_INVARIANT_VIOLATION`, com alerta): se ele dispara, o domínio deixou
  passar.
- Partidas dobradas, se um dia entrarem, mudam esta decisão: haveria lançamentos de
  contrapartida fora da carteira, e o trigger teria de distinguir as contas.
