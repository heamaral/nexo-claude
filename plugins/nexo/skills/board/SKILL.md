---
name: board
description: Abrir o board Nexo deste projeto no navegador, em tempo real.
disable-model-invocation: true
---

Use `mcp__plugin_nexo_nexo__board_open` com `openBrowser: true`.
Se o projeto ainda não tem Nexo, explique que `/nexo:init` inicializa o diretório. Não inicialize outro repositório por engano.
Informe apenas que o board local foi aberto. Se a abertura automática falhar, devolva o link temporário recebido.
Não leia nem exiba tokens de `.nexo/local/`.
