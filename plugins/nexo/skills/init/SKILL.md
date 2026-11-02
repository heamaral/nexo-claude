---
name: init
description: Inicializar o planejamento e o board Nexo no projeto atual.
disable-model-invocation: true
---

Use o MCP `init` para o diretório deste projeto. Ele cria `.nexo/project.json`, histórico de eventos, snapshot SQLite, regras em `.claude/rules/nexo.md` e alias `.claude/commands/board.md`, preservando arquivos existentes.
Depois use `board_open`. Explique que `.nexo/local/` é ignorada e que os demais arquivos de `.nexo/` são versionáveis.
Se já existe um comando `/board`, mantenha-o e informe que `/nexo:board` continua disponível.
Não acrescente permissões globais, não habilite Agent Teams experimentalmente e não altere configurações de outros projetos.
