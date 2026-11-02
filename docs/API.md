# Modelo e API MCP

Todos os IDs de domínio aceitam até 80 caracteres alfanuméricos, `_` e `-`. IDs de entidades são únicos no projeto, inclusive entre tipos. `commandId` precisa ser único por intenção e deve ser reutilizado apenas ao repetir exatamente a mesma requisição. `expectedVersion: 0` cria; updates usam a versão lida em `state`.

## Entidades

| Entidade | Campos principais                                                                                                         |
| -------- | ------------------------------------------------------------------------------------------------------------------------- |
| Delivery | id, title, description, workflow[], status, result, revisionOf?                                                           |
| Task     | id, deliveryId, parentId?, teamId?, title, description, stageId, dependencies[], criteria[], blocker?, result, evidence[] |
| Team     | id, deliveryId, title, description, workspace, engine, maxAgents                                                          |

Workflow: `{id, name, phase: queued|active|review|done, gate?: string}`. A entrega guarda o próprio workflow; é possível acrescentar uma etapa/gate enquanto aberta. Etapas em uso não podem ser removidas ou ter sua semântica trocada. Para renomear ou adicionar gates, atualize o workflow completo usando a versão atual da entrega.

`gate` é a descrição de um critério de validação. Nesta versão, um workflow com gate exige ao menos um SHA nas evidências de cada card concluído; não há um motor declarativo que execute pipelines ou interprete automaticamente o texto do gate. O planner e o reviewer verificam o critério e registram evidências. Projetos que precisam de aprovação humana podem modelar um card de aprovação dependente e mantê-lo pendente até receber a decisão.

Entrega aceita é imutável. `accept` exige todos os cards concluídos, resultado e ausência de agentes trabalhando. Nova solicitação cria nova entrega; `revisionOf` preserva vínculo com a anterior.

## Ferramentas

| Ferramenta | Uso                                                            |
| ---------- | -------------------------------------------------------------- |
| init       | Inicializa apenas o projeto corrente                           |
| state      | Snapshot autoritativo, versões, agentes, conflitos e saúde     |
| command    | create/update/accept com validação e idempotência              |
| claim      | Registra agente, escopos e lease; inicia card quando aplicável |
| heartbeat  | Renova lease não expirada e atividade                          |
| release    | Remove vínculo de agente sem concluir card                     |
| board_open | Gera login local de uso único e abre navegador                 |
| search     | Consulta FTS5 local, até 50 resultados                         |
| snapshot   | Gera SQLite fechado antes de commit                            |

Exemplo de card criado:

```json
{
  "commandId": "request-api-1",
  "actor": "planner",
  "op": "create",
  "kind": "task",
  "id": "api",
  "expectedVersion": 0,
  "data": {
    "deliveryId": "recovery",
    "title": "Implementar API",
    "stageId": "backlog",
    "dependencies": ["contract"],
    "criteria": ["Token não pode ser reutilizado"]
  }
}
```

Claim retorna token temporário e fence monotônico por card. Não salve tokens em descrições, evidências, prompts commitados ou Git. Use os IDs nativos injetados pelo hook e `sessionId` para que a limpeza automática funcione. `parentAgentId` permite a árvore de agentes. Role executor é único; colaboradores podem participar com escopos distintos; reviewers são declarados somente leitura. Todos contam na capacidade.

Escopos são arquivos/diretórios relativos explícitos. `.` representa todo o workspace. Não são aceitos glob, caminhos absolutos ou `..`. O sistema bloqueia sobreposição de escopos de escritores no board coordenador. Hooks de Write/Edit verificam caminho; shell continua dependente das permissões e disciplina de escopo do Claude.

Para concluir: atualize stageId para uma fase done com result/evidence e leaseToken vigente. O token não vai para o evento. Se outro colaborador estiver trabalhando, aguarde sua liberação. Lease expirada não é renovada; consulte estado, revalide alterações e obtenha outra claim.

## API HTTP interna

Somente loopback. Autorização bearer para ferramentas. O browser usa ticket de uso único, cookie HttpOnly SameSite Strict e somente leitura. Endpoints não são API pública estável: `/api/state`, `/api/events`, `/api/command`, `/api/claim`, `/api/heartbeat`, `/api/release`, `/api/snapshot`, `/api/hook`, `/api/resolve`. Não acesse `server.json` a partir de páginas de terceiros.
