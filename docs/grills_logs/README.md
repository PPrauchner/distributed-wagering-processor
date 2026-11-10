# Logs de grill

Registros das sessões em que decisões do projeto foram discutidas, pergunta a
pergunta. Servem para entender **por que** algo ficou como ficou.

## Regras

- **Uma pasta por unidade do projeto** (módulo ou contexto). A pasta nasce com o
  primeiro grill daquela unidade — não se criam pastas vazias de antemão.
- **`transversal/`** guarda o que toca mais de uma unidade ou é manutenção do
  repositório.
- **Releases.** Logo abaixo do título, uma linha `Releases: vX.Y.Z, ...` lista as
  releases que entregaram o que o grill decidiu. Sem essa linha, a decisão ainda não
  foi entregue.
- **O log não é fonte da verdade.** Numa mesma pasta, vale o log mais recente; e o
  que vale hoje está no código, nos ADRs (`docs/adr/`) e no `CONTEXT.md`.
- Um log existente não é reescrito: uma sessão nova acrescenta uma seção.
