---
name: plan
description: Planejar ou executar uma entrega com hierarquia, dependências, gates e agentes coordenados pelo Nexo.
argument-hint: '<resultado desejado>'
---

Objetivo solicitado: $ARGUMENTS

1. Consulte `state`; se não inicializado, use `init` no projeto atual.
2. Delegue o planejamento ao agente `nexo:planner`, transmitindo objetivo, limites e IDs de contexto. Ele deve registrar o plano pelo MCP antes de execução. Se delegação não estiver disponível, assuma explicitamente o papel de planner e siga suas regras.
3. Uma entrega aceita nunca é editada. Um pedido novo cria outra entrega, opcionalmente `revisionOf` apontando à anterior. Continuação de entrega aberta usa IDs/versões existentes.
4. Organize a hierarquia para decompor resultados e dependências para ordenar execução. Defina critérios mensuráveis e gates compatíveis com o projeto. Não replique colunas fixas se o contexto exige outras.
5. Times são unidades lógicas por entrega; use sessões independentes e worktrees para times que escrevem em paralelo. Dentro do time, use `nexo:worker` e `nexo:reviewer`, transmitindo taskId, teamId, parentAgentId, escopos e critérios. Cada agente usa sua própria identidade recebida pelo hook e chama `claim` antes de trabalhar.
6. Respeite os limites de `state.project`, capacidade dos times e conflitos de escrita. Não habilite recursos experimentais nem contorne as permissões do Claude. Um time nativo por sessão; a coordenação Nexo não remove limites nativos.
7. Os hooks renovam leases durante ferramentas e liberam agentes ao final da resposta. Em trabalho longo sem ferramentas, use `heartbeat` antes do TTL. SubagentStop não conclui card. Faça `command` com leaseToken para registrar resultado/evidências e concluir antes de `release`.
8. Integre as alterações e valide no mesmo commit. Registre esse SHA nas evidências dos gates. Só aceite a entrega quando todos os cards estiverem concluídos e os agentes liberados. Informe resultado e pendências reais.
9. Antes do commit do histórico, use `snapshot`. Nunca edite o SQLite, eventos ou tabelas internas do Claude manualmente.
