---
name: doctor
description: Diagnosticar instalação, conflitos de eventos e saúde do Nexo.
disable-model-invocation: true
---

Consulte `state`. Verifique healthError, conflicts, sessões sem contato e capacidade.
Para diagnóstico de runtime, execute via Bash (antes obtenha uma claim de manutenção se o projeto já estiver inicializado): `node "${CLAUDE_PLUGIN_ROOT}/runtime/cli.mjs" doctor`.
Não imprima tokens nem apague eventos. Para conflito Git, leia os eventos conflitantes e explique os dois resultados antes da resolução. O comando CLI `resolve <event-id>` reconhece explicitamente o evento perdedor; ele não aplica sua alteração. Reaplique o conteúdo desejado como novo `command` com a versão atual. Execute `snapshot` depois.
Um conflito binário em `.nexo/project.sqlite` se resolve reconstruindo o snapshot a partir dos eventos já conciliados; não escolha silenciosamente uma das branches como verdade.
